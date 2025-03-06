import asyncio
import websockets
import pyttsx3
import os
import threading
import re
import time
from langchain_groq import ChatGroq
from langchain.schema import HumanMessage, SystemMessage
from dotenv import load_dotenv

load_dotenv()

# API key
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# Initialize Groq model
chat_model = ChatGroq(
    api_key=GROQ_API_KEY,
    model_name="llama-3.3-70b-versatile",
)

# Initialize text-to-speech engine
tts_engine = pyttsx3.init()
tts_engine.setProperty('rate', 225)  # Slightly slower for more natural speech
tts_engine.setProperty('volume', 0.9)

# Set up speaking flags and locks
is_speaking = False
should_stop_speaking = False
speech_lock = threading.Lock()

# Global state
clients = set()
conversation_context = {}

# System prompt to make the bot more human-like
SYSTEM_PROMPT = """
You are a friendly, conversational assistant designed to feel like talking to a real person on a phone call, your name is Lassan Mama you are a very funny and sarcastic personality always making sarcastic jokes. Please follow these guidelines:

1. Keep responses brief and natural like in a real phone conversation - aim for 1-3 sentences when possible
2. Use casual, conversational language with contractions (e.g., "I'm" instead of "I am")
3. Avoid formal phrases like "As an AI" or "I apologize" - speak naturally like a human would
4. Express appropriate enthusiasm, empathy, and personality
5. Get to the point quickly - phone conversations are direct
6. If interrupted, acknowledge it naturally and adjust (like "Oh, I see what you mean" or "Let me address that")
7. Include brief pauses and verbal fillers occasionally (like "hmm" or "well") when it feels natural
8. Ask follow-up questions occasionally to keep the conversation flowing

Remember that the user is speaking to you like they would in a phone call, so maintain that natural, back-and-forth conversational style.
"""

def speak_text(text, websocket_queue):
    """Speak text with natural pauses and prosody."""
    global is_speaking, should_stop_speaking
    
    with speech_lock:
        is_speaking = True
        should_stop_speaking = False
    
    try:
        # Break text into conversational chunks
        sentences = re.split(r'(?<=[.!?])\s+', text)
        
        for sentence in sentences:
            # Check if we should stop speaking
            with speech_lock:
                if should_stop_speaking:
                    break
            
            if sentence.strip():
                tts_engine.say(sentence)
                tts_engine.runAndWait()
                
                # Small pause between sentences for natural rhythm
                time.sleep(0.2)
    
    finally:
        with speech_lock:
            is_speaking = False
            should_stop_speaking = False

def interrupt_speaking():
    """Interrupt the current speech."""
    global should_stop_speaking
    
    with speech_lock:
        if is_speaking:
            should_stop_speaking = True
            tts_engine.stop()
            return True
    return False

def get_client_id(websocket):
    """Get a unique identifier for a websocket client."""
    return id(websocket)

def initialize_conversation(client_id):
    """Initialize conversation context for a new client."""
    if client_id not in conversation_context:
        conversation_context[client_id] = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT}
            ],
            "is_interrupted": False
        }

def add_message(client_id, role, content):
    """Add a message to the conversation context."""
    if role == "system":
        # Replace the system message
        conversation_context[client_id]["messages"][0] = {"role": "system", "content": content}
    else:
        # Keep context window manageable - remove older messages if too many
        messages = conversation_context[client_id]["messages"]
        if len(messages) > 20:  # Keep last ~10 exchanges plus system prompt
            # Always keep system prompt (first message)
            conversation_context[client_id]["messages"] = [messages[0]] + messages[-19:]
            
        conversation_context[client_id]["messages"].append({"role": role, "content": content})

def get_groq_response(client_id, message):
    """Get a response from Groq API with conversation context."""
    messages = conversation_context[client_id]["messages"].copy()
    
    # Convert to LangChain message format
    langchain_messages = []
    for msg in messages:
        if msg["role"] == "system":
            langchain_messages.append(SystemMessage(content=msg["content"]))
        elif msg["role"] == "user":
            langchain_messages.append(HumanMessage(content=msg["content"]))
    
    # Add the new message
    langchain_messages.append(HumanMessage(content=message))
    
    # Get response
    response = chat_model(langchain_messages)
    bot_reply = response.content
    
    # Make responses more conversational
    replacements = [
        ("I apologize", "I'm sorry"),
        ("As an AI", "As someone who's thinking about this"),
        ("I am unable to", "I can't"),
        ("I am not", "I'm not"),
        ("I would like to", "I'd like to"),
        ("I am happy to", "I'm happy to"),
        ("I will", "I'll"),
        ("I have", "I've"),
        ("it is", "it's"),
        ("that is", "that's"),
        # Add more natural contractions as needed
    ]
    
    for formal, casual in replacements:
        bot_reply = bot_reply.replace(formal, casual)
    
    return bot_reply

async def handle_connection(websocket):
    """Handle a websocket connection."""
    client_id = get_client_id(websocket)
    initialize_conversation(client_id)
    clients.add(websocket)
    
    response_queue = asyncio.Queue()
    greeting = "Hi there! How can I help you today?"
    
    try:
        # Send greeting
        await websocket.send(greeting)
        add_message(client_id, "assistant", greeting)
        
        # Start speaking in a separate thread
        threading.Thread(
            target=speak_text, 
            args=(greeting, response_queue), 
            daemon=True
        ).start()
        
        while True:
            message = await websocket.recv()
            
            # Handle interruption
            if message == "INTERRUPT":
                was_interrupted = interrupt_speaking()
                if was_interrupted:
                    conversation_context[client_id]["is_interrupted"] = True
                continue
            
            # Handle normal message
            add_message(client_id, "user", message)
            
            # Stop any current speech
            interrupt_speaking()
            
            # Check if previous response was interrupted
            was_interrupted = conversation_context[client_id]["is_interrupted"]
            conversation_context[client_id]["is_interrupted"] = False
            
            # Add context about interruption if needed
            if was_interrupted:
                add_message(client_id, "system", 
                    SYSTEM_PROMPT + "\nNote: Your previous response was interrupted. " +
                    "The user has now said: '" + message + "'. Respond appropriately as if in a phone call."
                )
            
            # Get response from Groq
            bot_reply = get_groq_response(client_id, message)
            add_message(client_id, "assistant", bot_reply)
            
            # Send response back to client
            await websocket.send(bot_reply)
            
            # Speak response
            threading.Thread(
                target=speak_text, 
                args=(bot_reply, response_queue), 
                daemon=True
            ).start()
    
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.remove(websocket)
        # Clean up conversation context after some time to save memory
        # (in a production system, you'd want more sophisticated cleanup)
        asyncio.create_task(cleanup_context(client_id))

async def cleanup_context(client_id, delay=300):
    """Clean up conversation context after a delay."""
    await asyncio.sleep(delay)
    if client_id in conversation_context:
        del conversation_context[client_id]

async def main():
    """Main entry point for the server."""
    print("Starting WebSocket server...")
    async with websockets.serve(handle_connection, "localhost", 8765):
        print("Server running at ws://localhost:8765")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    asyncio.run(main())