// Load before the tests import application modules; never require a developer .env file.
process.env.BACKEND_TARGET_MODE = "local";
process.env.BACKEND_BASE_URL = "http://127.0.0.1:1";
process.env.BACKEND_INTERNAL_API_TOKEN = "test-token";
