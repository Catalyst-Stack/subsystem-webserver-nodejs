'use strict';

const codependency = require('codependency');
codependency.register(module, {
	index: ['optionalPeerDependencies']
});

const requirePeer = codependency.get('@catalyststack/subsystem-webserver');
const logger = requirePeer('@catalyststack/subsystem-logger')('webserver');

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const Koa = require('koa');
const cors = require('@koa/cors');
const Router = require('koa-joi-router');
const koaLogger = require('koa-logger');
const mount = require('koa-mount');
const passport = require('koa-passport');
const RedisStore = require('koa-redis');
const rewrite = require('koa-rewrite');
const session = require('koa-session');
const serve = require('koa-static');


const app = new Koa();
const router = new Router();

let serverConfig;
let httpServer;
let httpsServer;
let sessionStore;


/**
 * Expose JOI schema validation API class for route definition
 */
exports.Joi = Router.Joi;

/**
 * Expose Passport middleware for authentication definition
 */
exports.passport = passport;

/**
 * Expose middleware definition API
 * @param middleware
 */
exports.middleware = (middleware) => {
	app.use(middleware);
};

/**
 * Serves a given folder
 * @param path
 * @param folder
 * @param options
 */
exports.folder = (path, folder, options) => {
	logger.info('Registering Static Path:', path, '->', folder);
	app.use(mount(path, serve(folder, options)));
};

/**
 * Creates route handler
 * @param method
 * @param path
 * @param validate
 * @param handler
 */
exports.route = (method, path, validate, handler) => {
	logger.info('Registering Route Handler:', method, path);
	router.route({ method, path, validate, handler });
};

// TODO: implement command registration function for websockets commands

/**
 * Creates a rewrite route to forward requests
 * @param source
 * @param destination
 */
exports.rewrite = (source, destination) => {
	logger.info('Registering URL Rewrite:', source, '->', destination);
	app.use(rewrite(source, destination));
};

/**
 * Sets up the webserver so that it is ready to receive connections
 * @param config
 * @returns {Promise<void>}
 */
exports.setup = async (config) => {
	// Cache the config for later use
	serverConfig = config || {};

	// Setup koa cookie signing keys, the key used will be rotated on every signature
	app.keys = serverConfig.cookie.keys;

	// Setup koa access logging
	app.use(koaLogger((str) => logger.debug(str)));

	// Setup CORS if it was configured
	if (config.cors) {
		let allowOrigins = config.cors.allowOrigins;
		if (allowOrigins === true) {
			allowOrigins = undefined;
		} else if (Array.isArray(allowOrigins)) {
			allowOrigins = (ctx) => {
				if (config.cors.allowOrigins.indexOf(ctx.request.headers.origin) >= 0) {
					return ctx.request.headers.origin;
				}
			};
		}

		app.use(cors({
			origin: allowOrigins,
			allowMethods: config.cors.allowMethods,
			exposeHeaders: config.cors.exposeHeaders,
			allowHeaders: config.cors.allowHeaders,
			maxAge: config.cors.maxAge,
			credentials: config.cors.allowCredentials,
			keepHeadersOnError: true,
		}));
	}

	// Setup session management and storage
	await new Promise((resolve, reject) => {
		logger.notice('Setting up session store');
		sessionStore = new RedisStore({
			url: serverConfig.session.redis.url,
			db: serverConfig.session.redis.db,
		});

		sessionStore.once('ready', resolve);
		sessionStore.once('error', reject);
	});

	app.use(session({
		key: serverConfig.session.key,
		maxAge: serverConfig.session.maxAge,
		rolling: true,
		store: sessionStore,
		httpOnly: false,
	}, app));

	// Setup passport authentication middleware
	app.use(passport.initialize());
	app.use(passport.session());
};

/**
 * Starts the webserver and starts accepting connections
 * @returns {Promise<void>}
 */
exports.start = async () => {
	// Make sure the route handler middleware is the last one attached
	app.use(router.middleware());

	// Start listening for HTTP requests
	if (serverConfig.http.listen) {
		let httpHost, httpPort;
		if (serverConfig.http.listen === true) {
			httpHost = '0.0.0.0';
			httpPort = 80;
		} else {
			const httpListen = serverConfig.http.listen.split(':');
			httpHost = httpListen[0];
			httpPort = httpListen[1] || 80;
		}

		httpServer = http.createServer(app.callback());

		await new Promise((resolve) => httpServer.listen(httpPort, httpHost, resolve));
		logger.notice('HTTP listening on:', `${httpHost}:${httpPort}`);

		// TODO: error handling for socket termination and other edge cases

		// TODO: implement websocket upgrade handling
	}

	// Start listening for HTTPS requests
	if (serverConfig.https.listen) {
		let httpsHost, httpsPort;
		if (serverConfig.https.listen === true) {
			httpsHost = '0.0.0.0';
			httpsPort = 443;
		} else {
			const httpsListen = serverConfig.https.listen.split(':');
			httpsHost = httpsListen[0];
			httpsPort = httpsListen[1] || 80;
		}

		const httpsOptions = {
			key: fs.readFileSync(path.resolve(__dirname, '../../../..', serverConfig.https.keyPath)),
			cert: fs.readFileSync(path.resolve(__dirname, '../../../..', serverConfig.https.certPath)),
			ca: fs.readFileSync(path.resolve(__dirname, '../../../..', serverConfig.https.caPath))
		};

		httpsServer = https.createServer(httpsOptions, app.callback());

		await new Promise((resolve) => httpsServer.listen(httpsPort, httpsHost, resolve));
		logger.notice('HTTPS listening on port:', `${httpsHost}:${httpsPort}`);

		// TODO: error handling for socket termination and other edge cases

		// TODO: implement websocket upgrade handling
	}
};

/**
 * Stops all connections within the webserver
 * @returns {Promise<void>}
 */
exports.stop = async () => {
	if (sessionStore) {
		await new Promise((resolve) => sessionStore.client.quit(resolve));
		logger.notice('Session store stopped');
	}

	if (httpServer) {
		await new Promise((resolve) => httpServer.close(resolve));
		logger.notice('HTTP server stopped');
	}

	if (httpsServer) {
		await new Promise((resolve) => httpsServer.close(resolve));
		logger.notice('HTTPS server stopped');
	}
};
