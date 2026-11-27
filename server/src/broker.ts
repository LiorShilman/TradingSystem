import http from 'node:http';
import https from 'node:https';
import {
  buildBrokerSnapshot,
  nowUtcIso,
  parseFxcmgrAccount,
  parseFxcmgrPositions,
  type BrokerSnapshot,
  type FxcmgrConfig,
} from '@trading/shared';

type Conn = Pick<FxcmgrConfig, 'baseUrl' | 'hostHeader'>;

/**
 * One read-only POST to FXCMgr, returning parsed JSON. Injectable for tests.
 * The body is sent as-is: FXCMgr does not URL-decode, so "pairs=USD/ILS" must keep its raw "/".
 */
export type FxcmgrClient = (cfg: Conn, path: '/trading/get_model' | '/subscribe', body: string) => Promise<unknown>;

// fetch() cannot override Host, which HTTP.sys listeners bound to a DNS name require.
export const defaultFxcmgrClient: FxcmgrClient = (cfg, path, body) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, cfg.baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          ...(cfg.hostHeader ? { Host: cfg.hostHeader } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            const hint = res.statusCode === 400 && /Hostname/i.test(data) ? ' — כנראה צריך להגדיר Host' : '';
            return reject(new Error(`FXCMgr החזיר HTTP ${res.statusCode}${hint}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('FXCMgr החזיר תשובה שאינה JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('FXCMgr לא ענה בזמן')));
    req.on('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'ECONNREFUSED' ? 'FXCMgr לא זמין (האפליקציה כבויה?)' : e.message)),
    );
    req.end(body);
  });

export async function fetchFxcmgrSnapshot(cfg: Conn, client: FxcmgrClient = defaultFxcmgrClient): Promise<BrokerSnapshot> {
  const [acc, pos] = await Promise.all([
    client(cfg, '/trading/get_model', 'models=Account'),
    client(cfg, '/trading/get_model', 'models=OpenPosition'),
  ]);
  return buildBrokerSnapshot(parseFxcmgrAccount(acc), parseFxcmgrPositions(pos), nowUtcIso());
}
