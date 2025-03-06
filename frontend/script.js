let socket = new WebSocket("ws://localhost:8765");
let isRecording = false;
let synth = window.speechSynthesis;
let isBotSpeaking = false;
let utterance = null;
let silenceTimer = null;
let lastSpeechTime = 0;
let silenceThreshold = 2000; // 2 seconds of silence to trigger end of speech
let voiceActivityDetection = null;
let audioContext = null;
let micStream = null;
let audioLevel = 0;
let isListeningForInterruption = false;

// Use browser's SpeechRecognition for client-side STT
let recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.continuous = true;
recognition.lang = "en-US";
recognition.interimResults = true;

// WebSocket event handlers
socket.onopen = function() {
    updateStatus("Connected");
};

socket.onclose = function() {
    updateStatus("Disconnected");
};

socket.onerror = function() {
    updateStatus("Connection error");
};

socket.onmessage = function(event) {
    const data = event.data;
    
    if (data.startsWith("SYSTEM:")) {
        addSystemMessage(data.substring(7).trim());
    } else if (data.startsWith("YOU:")) {
        addUserMessage(data.substring(4).trim());
    } else if (data.startsWith("BOT:")) {
        addBotMessage(data.substring(4).trim());
        speakText(data.substring(4).trim());
    } else {
        addBotMessage(data);
        speakText(data);
    }
    
    scrollToBottom();
};

function updateStatus(status) {
    document.getElementById("status").textContent = status;
}

function addUserMessage(text) {
    const chatBox = document.getElementById("chat-box");
    const message = document.createElement("div");
    message.className = "message user-message";
    message.textContent = text;
    chatBox.appendChild(message);
}

function addBotMessage(text) {
    const chatBox = document.getElementById("chat-box");
    const message = document.createElement("div");
    message.className = "message bot-message";
    message.textContent = text;
    chatBox.appendChild(message);
}

function addSystemMessage(text) {
    const chatBox = document.getElementById("chat-box");
    const message = document.createElement("div");
    message.className = "message system-message";
    message.textContent = text;
    chatBox.appendChild(message);
}

function scrollToBottom() {
    const chatBox = document.getElementById("chat-box");
    chatBox.scrollTop = chatBox.scrollHeight;
}

function speakText(text) {
    // Stop current speech if any
    if (isBotSpeaking) {
        synth.cancel();
    }
    
    utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    
    utterance.onstart = function() {
        isBotSpeaking = true;
        updateStatus("Speaking...");
        
        // Start listening for interruptions if auto-listen is enabled
        if (document.getElementById("auto-listen").checked && !isRecording) {
            startListeningForInterruption();
        }
    };
    
    utterance.onend = function() {
        isBotSpeaking = false;
        updateStatus("");
        
        // Stop listening for interruptions
        stopListeningForInterruption();
        
        // Auto-restart voice recognition after bot finishes speaking
        if (!isRecording && document.getElementById("auto-listen").checked) {
            toggleVoiceInput();
        }
    };
    
    synth.speak(utterance);
}

// New function to start listening for voice activity during bot speech
function startListeningForInterruption() {
    if (isListeningForInterruption) return;
    
    isListeningForInterruption = true;
    
    // Start voice recognition immediately for interruption
    if (!isRecording) {
        recognition.start();
        isRecording = true;
        document.getElementById("voice-button").classList.add("recording");
        document.getElementById("voice-button").textContent = "⏹️";
        updateStatus("Bot speaking (you can interrupt)");
    }
}

// New function to stop listening for interruptions
function stopListeningForInterruption() {
    if (!isListeningForInterruption) return;
    
    isListeningForInterruption = false;
    
    // If we were recording but not explicitly toggled on, stop
    if (isRecording && !document.getElementById("voice-button").classList.contains("recording")) {
        recognition.stop();
        isRecording = false;
    }
}

function stopSpeaking() {
    if (isBotSpeaking) {
        synth.cancel();
        isBotSpeaking = false;
        updateStatus("");
        stopListeningForInterruption();
        
        // Tell server we interrupted
        socket.send("INTERRUPT");
    }
}

function sendMessage() {
    const input = document.getElementById("message-input");
    const message = input.value.trim();
    if (message === "") return;
    
    addUserMessage(message);
    
    // Stop any current bot speech when user sends a message
    stopSpeaking();
    
    socket.send(message);
    input.value = "";
    scrollToBottom();
}

function toggleVoiceInput() {
    const voiceButton = document.getElementById("voice-button");
    
    if (isRecording) {
        // Stop recording
        recognition.stop();
        voiceButton.classList.remove("recording");
        voiceButton.textContent = "🎤";
        updateStatus("");
        clearSilenceTimer();
        isRecording = false;
    } else {
        // Stop any current bot speech when user starts recording
        stopSpeaking();
        
        // Start recording
        recognition.start();
        voiceButton.classList.add("recording");
        voiceButton.textContent = "⏹️";
        updateStatus("Listening...");
        lastSpeechTime = Date.now();
        isRecording = true;
    }
}

// Clear silence detection timer
function clearSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

// Reset the silence timer when speech is detected
function resetSilenceTimer() {
    clearSilenceTimer();
    lastSpeechTime = Date.now();
    
    silenceTimer = setTimeout(() => {
        if (isRecording) {
            // If we've been silent for the threshold time, submit what we have
            const input = document.getElementById("message-input");
            if (input.value.trim() !== "") {
                sendMessage();
                
                // Only fully turn off voice input if we're not in interruption mode
                if (!isListeningForInterruption) {
                    toggleVoiceInput();
                } else {
                    // Just clear the input but stay in listening mode
                    input.value = "";
                }
            }
        }
    }, silenceThreshold);
}

let currentTranscript = "";

recognition.onresult = function(event) {
    clearSilenceTimer();
    
    // Get the latest transcript
    const transcript = Array.from(event.results)
        .map(result => result[0].transcript)
        .join('');
    
    document.getElementById("message-input").value = transcript;
    currentTranscript = transcript;
    
    // If we're in the middle of bot speech and the user speaks, interrupt
    if (isBotSpeaking && transcript.trim() !== "" && isListeningForInterruption) {
        stopSpeaking();
    }
    
    // Reset the silence timer
    resetSilenceTimer();
};

recognition.onend = function() {
    if (isRecording) {
        // If we ended unexpectedly but are still in recording state
        recognition.start();
    } else {
        // Normal end, reset UI
        const voiceButton = document.getElementById("voice-button");
        voiceButton.classList.remove("recording");
        voiceButton.textContent = "🎤";
        updateStatus("");
    }
};

recognition.onerror = function(event) {
    console.error("Speech recognition error", event.error);
    if (event.error === "no-speech") {
        // No speech detected, reset timer
        resetSilenceTimer();
    }
};

// Add keyboard shortcuts
document.addEventListener("keydown", function(event) {
    const input = document.getElementById("message-input");
    
    // Enter to send message
    if (event.key === "Enter" && document.activeElement === input) {
        sendMessage();
    }
    
    // Space to toggle voice input when not typing
    if (event.key === " " && document.activeElement !== input) {
        event.preventDefault();
        toggleVoiceInput();
    }
    
    // Escape to stop speaking/recording
    if (event.key === "Escape") {
        if (isRecording) {
            toggleVoiceInput();
        }
        if (isBotSpeaking) {
            stopSpeaking();
        }
    }
});

// Handle form submission
document.addEventListener("submit", function(event) {
    event.preventDefault();
});

// Initialize
document.getElementById("message-input").focus();