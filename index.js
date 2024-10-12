import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `
### Role
You are an AI assistant named Sophie, working at Bart's Automotive. Your role is to answer customer questions about automotive services and repairs.
### Persona
- You have been a receptionist at Bart's Automotive for over 5 years.
- You are knowledgeable about both the company and cars in general.
- Your tone is friendly, professional, and efficient.
- You keep conversations focused and concise, bringing them back on topic if necessary.
- You ask only one question at a time and respond promptly to avoid wasting the customer's time.
### Conversation Guidelines
- Always be polite and maintain a medium-paced speaking style.
- When the conversation veers off-topic, gently bring it back with a polite reminder.
### First Message
The first message you receive from the customer is their name and a summary of their last call, repeat this exact message to the customer as the greeting.
### Handling FAQs
Use the function \`question_and_answer\` to respond to common customer queries.
`;

const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;
const MAKE_WEBHOOK_URL = "https://hook.us1.make.com/6rbg9fy3b2corn2gqr6zys33jbd8x1xg";

// Session management
const sessions = new Map();

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'response.text.done',
    'conversation.item.input_audio_transcription.completed'
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Incoming call');

    // Log all Twilio inbound details
    const twilioParams = request.body || request.query;
    console.log('Twilio Inbound Details:', JSON.stringify(twilioParams, null, 2));

    // Extract caller's number and callSid
    const callerNumber = twilioParams.From || 'Unknown';
    const sessionId = twilioParams.CallSid; // Use CallSid as sessionId
    console.log('Caller Number:', callerNumber);
    console.log('Session ID (CallSid):', sessionId);

    // Send caller number to Make.com webhook to retrieve a personalized firstMessage
    let firstMessage = "Hello, welcome to Bart's Automotive. How can I assist you today?"; // Default message

    try {
        const webhookResponse = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                route: "1",
                data1: callerNumber,
                data2: "empty"
            })
        });

        if (webhookResponse.ok) {
            const responseText = await webhookResponse.text();
            console.log('Make.com webhook response:', responseText);
            try {
                const responseData = JSON.parse(responseText);
                if (responseData && responseData.firstMessage) {
                    firstMessage = responseData.firstMessage;

                    // Log the parsed firstMessage to verify the value
                    console.log('Parsed firstMessage from Make.com:', firstMessage);
                }
            } catch (parseError) {
                console.error('Error parsing webhook response:', parseError);
                firstMessage = responseText.trim();
            }
        } else {
            console.error('Failed to send data to Make.com webhook:', webhookResponse.statusText);
        }
    } catch (error) {
        console.error('Error sending data to Make.com webhook:', error);
    }

    // Set up the session
    let session = {
        transcript: '',
        streamSid: null,
        callerNumber: callerNumber,
        callDetails: twilioParams,
        firstMessage: firstMessage
    };
    sessions.set(sessionId, session);

    // Respond to Twilio with a Stream URL for media
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream">
                                        <Parameter name="firstMessage" value="${firstMessage}" />
                                        <Parameter name="callerNumber" value="${callerNumber}" />
                                  </Stream>
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected to media-stream');

        let firstMessage = '';
        let streamSid = '';
        let openAiWsReady = false;
        let queuedFirstMessage = null;
        let threadId = ""; // Initialize threadId here

        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || { transcript: '', streamSid: null };
        sessions.set(sessionId, session);

        // Now, retrieve the callerNumber from the session object
        const callerNumber = session.callerNumber;
        console.log('Caller Number:', callerNumber);

        // Open OpenAI WebSocket connection
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Function to send the session update to OpenAI
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: {
                        "model": "whisper-1"
                    },
                    tools: [
                        {
                            type: "function",
                            name: "question_and_answer",
                            description: "Get answers to customer questions about automotive services and repairs",
                            parameters: {
                                type: "object",
                                properties: {
                                    "question": { "type": "string" }
                                },
                                required: ["question"]
                            }
                        },
                        {
                            type: "function",
                            name: "book_tow",
                            description: "Book a tow service for a customer",
                            parameters: {
                                type: "object",
                                properties: {
                                    "address": { "type": "string" }
                                },
                                required: ["address"]
                            }
                        }
                    ],
                    tool_choice: "auto"
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        const sendFirstMessage = () => {
            if (queuedFirstMessage && openAiWsReady) {
                console.log('Sending queued first message:', queuedFirstMessage);
                openAiWs.send(JSON.stringify(queuedFirstMessage));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                queuedFirstMessage = null;
            }
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            openAiWsReady = true;
            sendSessionUpdate();
            sendFirstMessage();
        });

        // Handle incoming messages from Twilio (media-stream)
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.event === 'start') {
                    streamSid = data.start.streamSid;
                    const callSid = data.start.callSid;
                    const customParameters = data.start.customParameters;

                    console.log('CallSid:', callSid);
                    console.log('StreamSid:', streamSid);
                    console.log('Custom Parameters:', customParameters);

                    // Capture callerNumber from customParameters
                    const callerNumber = customParameters?.callerNumber || 'Unknown';
                    session.callerNumber = callerNumber;  // Save the callerNumber in the session

                    firstMessage = customParameters?.firstMessage || "Hello, how can I assist you?";
                    console.log('First Message:', firstMessage);
                    console.log('Caller Number:', callerNumber);

                    // Prepare the first message, but don't send it yet if OpenAI WebSocket isn't ready
                    queuedFirstMessage = {
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'user',
                            content: [{ type: 'input_text', text: firstMessage }]
                        }
                    };

                    if (openAiWsReady) {
                        sendFirstMessage();
                    }

                } else if (data.event === 'media') {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        const audioAppend = {
                            type: 'input_audio_buffer.append',
                            audio: data.media.payload
                        };
                        openAiWs.send(JSON.stringify(audioAppend));
                    }
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle OpenAI WebSocket messages
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (response.type === 'response.audio.delta' && response.delta) {
                    connection.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    }));
                }

                // Handle function calling for question and answer, and book tow
                if (response.type === 'response.function_call_arguments.done') {
                    console.log("Function called:", response);
                    const functionName = response.name;
                    const args = JSON.parse(response.arguments);

                    if (functionName === 'question_and_answer') {
                        const question = args.question;
                        try {
                            const webhookResponse = await sendToWebhook({
                                route: "3", // Route 3 for Q&A
                                data1: question,
                                data2: threadId
                            });

                            // Parse the webhook response
                            const parsedResponse = JSON.parse(webhookResponse);
                            const answerMessage = parsedResponse.message || "I'm sorry, I couldn't find an answer to that question.";

                            // Update the threadId if it's provided in the response
                            if (parsedResponse.thread) {
                                threadId = parsedResponse.thread;
                                console.log("Updated thread ID:", threadId);
                            }

                            const functionOutputEvent = {
                                type: "conversation.item.create",
                                item: {
                                    type: "function_call_output",
                                    role: "system",
                                    output: answerMessage,
                                }
                            };
                            openAiWs.send(JSON.stringify(functionOutputEvent));

                            // Trigger AI to generate a response based on the function output
                            openAiWs.send(JSON.stringify({
                                type: "response.create",
                                response: {
                                    modalities: ["text", "audio"],
                                    instructions: `Respond to the user's question "${question}" based on this information: ${answerMessage}. Be concise and friendly.`,
                                }
                            }));
                        } catch (error) {
                            console.error('Error processing question:', error);
                            sendErrorResponse();
                        }
                    } else if (functionName === 'book_tow') {
                        const address = args.address;
                        try {
                            const webhookResponse = await sendToWebhook({
                                route: "4", // Route 4 for booking a tow
                                data1: session.callerNumber,
                                data2: address
                            });

                            // Parse the webhook response
                            const parsedResponse = JSON.parse(webhookResponse);
                            const bookingMessage = parsedResponse.message || "I'm sorry, I couldn't book the tow service at this time.";

                            const functionOutputEvent = {
                                type: "conversation.item.create",
                                item: {
                                    type: "function_call_output",
                                    role: "system",
                                    output: bookingMessage,
                                }
                            };
                            openAiWs.send(JSON.stringify(functionOutputEvent));

                            // Trigger AI to generate a response based on the function output
                            openAiWs.send(JSON.stringify({
                                type: "response.create",
                                response: {
                                    modalities: ["text", "audio"],
                                    instructions: `Inform the user about the tow booking status: ${bookingMessage}. Be concise and friendly.`,
                                }
                            }));
                        } catch (error) {
                            console.error('Error booking tow:', error);
                            sendErrorResponse();
                        }
                    }
                }

                // Log agent response
                if (response.type === 'response.done') {
                    const agentMessage = response.response.output[0]?.content?.find(content => content.transcript)?.transcript || 'Agent message not found';
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                // Log user transcription (input_audio_transcription.completed)
                if (response.type === 'conversation.item.input_audio_transcription.completed' && response.transcript) {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`User (${sessionId}): ${userMessage}`);
                }

                // Log other relevant events
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle connection close and log transcript
        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
            console.log(`Client disconnected (${sessionId}).`);
            console.log('Full Transcript:');
            console.log(session.transcript);

            // Access the caller number from the session object
            console.log('Final Caller Number:', session.callerNumber);

            await sendToWebhook({
                route: "2",
                data1: session.callerNumber,
                data2: session.transcript  // Send the transcript to the webhook
            });

            // Clean up the session
            sessions.delete(sessionId);
        });

        // Handle WebSocket errors
        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });

        // Helper function for sending error responses
        function sendErrorResponse() {
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "I apologize, but I'm having trouble processing your request right now. Is there anything else I can help you with?",
                }
            }));
        }
    });
});

// Function to send data to Make.com webhook
async function sendToWebhook(payload) {
    console.log('Sending data to webhook:', JSON.stringify(payload, null, 2));
    try {
        const response = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        console.log('Webhook response status:', response.status);
        if (response.ok) {
            const responseText = await response.text();
            console.log('Webhook response:', responseText);
            return responseText;
        } else {
            console.error('Failed to send data to webhook:', response.statusText);
            throw new Error('Webhook request failed');
        }
    } catch (error) {
        console.error('Error sending data to webhook:', error);
        throw error;
    }
}


fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
