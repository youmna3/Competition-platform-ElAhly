import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

const base = { DB_USER: 'root' };

describe('parseConfig', () => {
  it('applies safe local defaults', () => {
    const config = parseConfig(base);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4000);
    expect(config.allowNetworkAccess).toBe(false);
    expect(config.db).toEqual({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database: 'judging_platform',
      connectionLimit: 10,
    });
    expect(config.isProduction).toBe(false);
  });

  it('accepts the empty XAMPP root password', () => {
    expect(parseConfig({ ...base, DB_PASSWORD: '' }).db.password).toBe('');
  });

  it('treats empty values as unset so defaults apply', () => {
    expect(parseConfig({ ...base, PORT: '', DB_NAME: '' }).port).toBe(4000);
  });

  it('requires DB_USER', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
  });

  it('rejects an unsafe database name', () => {
    expect(() => parseConfig({ ...base, DB_NAME: 'judging; DROP DATABASE x' })).toThrow(/DB_NAME/);
  });

  it('rejects invalid ports', () => {
    expect(() => parseConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseConfig({ ...base, DB_PORT: 'abc' })).toThrow(/DB_PORT/);
  });

  it('refuses to bind to the network unless explicitly allowed', () => {
    expect(() => parseConfig({ ...base, HOST: '0.0.0.0' })).toThrow(/ALLOW_NETWORK_ACCESS/);
    const config = parseConfig({ ...base, HOST: '0.0.0.0', ALLOW_NETWORK_ACCESS: 'true' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.allowNetworkAccess).toBe(true);
  });

  it('allows loopback hosts', () => {
    for (const HOST of ['127.0.0.1', 'localhost', '::1']) {
      expect(parseConfig({ ...base, HOST }).host).toBe(HOST);
    }
  });

  it('rejects a malformed boolean flag', () => {
    expect(() => parseConfig({ ...base, ALLOW_NETWORK_ACCESS: 'yes' })).toThrow(
      /ALLOW_NETWORK_ACCESS/,
    );
  });
});
