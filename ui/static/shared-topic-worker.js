const ports = new Set();
const portTopics = new Map();
const latestSnapshots = new Map();
const latestCrawlSnapshots = new Map();
const topics = new Set();

let wsUrl = '';
let socket = null;
let retryTimer = null;
let retryAttempt = 0;
let pendingMessages = [];
let appVersion = 'development';

self.onconnect = (event) => {
	const port = event.ports[0];

	ports.add(port);
	portTopics.set(port, new Set());
	port.start();

	port.onmessage = (messageEvent) => {
		const message = messageEvent.data;

		if (!message || typeof message !== 'object') {
			return;
		}

		if (message.type === 'connect') {
			wsUrl = message.wsUrl;
			appVersion = message.appVersion || appVersion;
			postToPort(port, { type: 'state', state: socket ? socketState(socket) : 'idle' });
			ensureSocket();
			return;
		}

		if (message.type === 'subscribe') {
			subscribePort(port, message.topic);
			return;
		}

		if (message.type === 'unsubscribe') {
			unsubscribePort(port, message.topic);
			return;
		}

		if (message.type === 'crawl_snapshots') {
			sendOrQueueSocketMessage({
				type: 'crawl_snapshots',
				topic: message.topic,
				since_ms: message.since_ms,
			});
			return;
		}

		if (message.type === 'latest_crawl_snapshot') {
			sendOrQueueSocketMessage({
				type: 'latest_crawl_snapshot',
				topic: message.topic,
			});
			return;
		}


		if (message.type === 'disconnect') {
			removePort(port);
		}
	};
};

function subscribePort(port, topic) {
	if (!topic) {
		return;
	}

	portTopics.get(port)?.add(topic);

	if (!topics.has(topic)) {
		topics.add(topic);
		sendSocketMessage({ type: 'subscribe', topics: [topic] });
	}

	const latest = latestSnapshots.get(topic);
	if (latest) {
		postToPort(port, { type: 'server', message: latest });
	}

	const latestCrawlSnapshot = latestCrawlSnapshots.get(topic);
	if (latestCrawlSnapshot) {
		postToPort(port, { type: 'server', message: latestCrawlSnapshot });
	}

	ensureSocket();
}

function unsubscribePort(port, topic) {
	portTopics.get(port)?.delete(topic);
	refreshTopics();

	if (!topics.has(topic)) {
		sendSocketMessage({ type: 'unsubscribe', topics: [topic] });
	}
}

function removePort(port) {
	ports.delete(port);
	portTopics.delete(port);
	refreshTopics();
	port.close();

	if (!ports.size) {
		closeSocket();
	}
}

function refreshTopics() {
	const nextTopics = new Set();

	for (const subscribedTopics of portTopics.values()) {
		for (const topic of subscribedTopics) {
			nextTopics.add(topic);
		}
	}

	topics.clear();
	for (const topic of nextTopics) {
		topics.add(topic);
	}
}

function ensureSocket() {
	if (!wsUrl || socket || (!topics.size && !pendingMessages.length)) {
		return;
	}

	broadcast({ type: 'state', state: 'connecting' });
	socket = new WebSocket(wsUrl);

	socket.addEventListener('open', () => {
		retryAttempt = 0;
		broadcast({ type: 'state', state: 'open' });
		sendSocketMessage({
			type: 'client_hello',
			app_version: appVersion,
		});
		if (topics.size) {
			sendSocketMessage({ type: 'subscribe', topics: [...topics] });
		}
		for (const message of pendingMessages) {
			sendSocketMessage(message);
		}
		pendingMessages = [];
	});

	socket.addEventListener('message', (event) => {
		let message;

		try {
			message = JSON.parse(event.data);
		} catch {
			broadcast({ type: 'error', message: 'Received an invalid WebSocket message.' });
			return;
		}

		if (message.type === 'topic_snapshot') {
			latestSnapshots.set(message.topic, message);
			broadcastToTopic(message.topic, { type: 'server', message });
			return;
		}

		if (message.type === 'crawl_snapshot') {
			latestCrawlSnapshots.set(message.topic, message);
			broadcastToTopic(message.topic, { type: 'server', message });
			return;
		}

		if (message.type === 'crawl_snapshots') {
			broadcastToTopic(message.topic, { type: 'server', message });
			return;
		}

		// Guest comment pushes are topic-scoped, so they follow the same fan-out as snapshots.
		// Only approved comments ever arrive here; pending ones are never broadcast by the server.
		if (
			message.type === 'guest_comment_created' ||
			message.type === 'guest_comment_removed' ||
			message.type === 'guest_comment_count'
		) {
			broadcastToTopic(message.topic, { type: 'server', message });
			return;
		}


		if (message.type === 'client_reload') {
			broadcast({ type: 'client_reload', message });
			return;
		}

		broadcast({ type: 'server', message });
	});

	socket.addEventListener('close', () => {
		socket = null;
		broadcast({ type: 'state', state: 'closed' });

		if (topics.size) {
			const delay = Math.min(1000 * 2 ** retryAttempt, 10000);
			retryAttempt += 1;
			retryTimer = setTimeout(ensureSocket, delay);
		}
	});

	socket.addEventListener('error', () => {
		broadcast({ type: 'state', state: 'error' });
		broadcast({ type: 'error', message: 'WebSocket connection failed.' });
	});
}

function closeSocket() {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}

	socket?.close();
	socket = null;
	retryAttempt = 0;
}

function sendSocketMessage(message) {
	if (socket?.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}

function sendOrQueueSocketMessage(message) {
	if (socket?.readyState === WebSocket.OPEN) {
		sendSocketMessage(message);
		return;
	}

	pendingMessages.push(message);
	ensureSocket();
}

function socketState(value) {
	if (value.readyState === WebSocket.CONNECTING) {
		return 'connecting';
	}

	if (value.readyState === WebSocket.OPEN) {
		return 'open';
	}

	return 'closed';
}

function broadcast(message) {
	for (const port of ports) {
		postToPort(port, message);
	}
}

function broadcastToTopic(topic, message) {
	for (const [port, subscribedTopics] of portTopics.entries()) {
		if (subscribedTopics.has(topic)) {
			postToPort(port, message);
		}
	}
}


function postToPort(port, message) {
	try {
		port.postMessage(message);
	} catch {
		removePort(port);
	}
}
