/**
 * Compatibility shim.
 *
 * `package.json` now points the package entry at `host.js`: this plugin was
 * first installed while Node still held an older module generation for this
 * file, and a new entry URL is what loads fresh code without restarting the Web
 * process. Keeping this file means any older reference still resolves.
 *
 * @module dsh-web-api-balance
 */
export { Config, BASE_PATH, inject, apply } from './host.js'
