import PluginWorker from './plugin.worker?worker&inline';
import { parsePluginAction, type PluginAction, type PluginContext, type PluginManifest } from './pluginApi';

export function runPlugin(plugin: PluginManifest, command: string, context: PluginContext): Promise<PluginAction> {
  return new Promise((resolve, reject) => {
    const worker = new PluginWorker();
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('Plugin execution timed out.'));
    }, 4000);
    worker.onmessage = (event) => {
      finish();
      try {
        if (event.data?.ok !== true) throw new Error(event.data?.error || 'Plugin failed.');
        resolve(parsePluginAction(event.data.value, plugin));
      } catch (error) {
        reject(error);
      }
    };
    worker.onerror = () => {
      finish();
      reject(new Error('Plugin runtime could not start.'));
    };
    worker.postMessage({ script: plugin.script, command, context });
  });
}
