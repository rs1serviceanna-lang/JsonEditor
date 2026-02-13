
import WebSocket from '../metax_zero_webserver/metax_2/node_modules/ws/index.js';

const BASE_URL = 'https://localhost:5001';
const WS_URL = 'wss://localhost:5001';
const UUID = '5909ce96-f166-4662-b291-11d651ed2f70-a27156a8-fb53-4e3d-be02-954feb7ac311';

async function test() {
    console.log('Connecting to WebSocket...');
    const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });

    ws.on('open', () => {
        console.log('WebSocket connected.');
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data.toString());
        console.log('Received message:', msg);

        if (msg.event === 'connected') {
            const token = msg.token;
            console.log('Token received:', token);

            try {
                console.log('Registering listener...');
                const url = `${BASE_URL}/db/register_listener?id=${UUID}&token=${token}`;
                const response = await fetch(url);
                const result = await response.json();
                console.log('Registration response:', result);
            } catch (error) {
                console.error('Registration failed:', error.message);
            } finally {
                ws.close();
            }
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });

    ws.on('close', () => {
        console.log('WebSocket closed.');
    });
}

test();
