import { proto } from '@whiskeysockets/baileys';
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils.js';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics.js';
import { authStateGet, authStateSet, authStateRemove } from '../lib/db.js';

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

export async function usePgAuthState() {
  const readData = async (key) => {
    const raw = await authStateGet(fixFileName(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const writeData = async (key, data) => {
    if (data === undefined) {
      await authStateRemove(fixFileName(key));
    } else {
      await authStateSet(fixFileName(key), JSON.stringify(data, BufferJSON.replacer));
    }
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}.json`;
              tasks.push(writeData(key, value));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds.json', creds);
    }
  };
}
