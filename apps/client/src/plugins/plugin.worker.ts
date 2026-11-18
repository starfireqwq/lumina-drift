import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import type { PluginContext } from './pluginApi';

self.onmessage = async (event: MessageEvent<{ script: string; command: string; context: PluginContext }>) => {
  const { script, command, context } = event.data;
  try {
    const engine = await newQuickJSWASMModuleFromVariant(variant);
    const runtime = engine.newRuntime();
    try {
      runtime.setMemoryLimit(16 * 1024 * 1024);
      runtime.setMaxStackSize(256 * 1024);
      const deadline = performance.now() + 500;
      runtime.setInterruptHandler(() => performance.now() > deadline);
      const vm = runtime.newContext();
      try {
        // The VM receives JSON and no host functions, modules, DOM, or network APIs.
        const code = `(function () {
          "use strict";
          const serialize = JSON.stringify;
          const execute = function () {
            ${script}
            return run(${JSON.stringify(command)}, Object.freeze(${JSON.stringify(context)}));
          };
          return serialize(execute());
        })()`;
        const result = vm.evalCode(code, 'plugin.js', { type: 'global' });
        if (result.error) {
          result.error.dispose();
          throw new Error('Script failed or exceeded its execution limit.');
        }
        try {
          if (vm.typeof(result.value) !== 'string') throw new Error('A command must return one action.');
          const json = vm.getString(result.value);
          if (json.length > 192 * 1024) throw new Error('Plugin output is too large.');
          self.postMessage({ ok: true, value: JSON.parse(json) });
        } finally {
          result.value.dispose();
        }
      } finally {
        vm.dispose();
      }
    } finally {
      runtime.dispose();
    }
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Plugin failed.' });
  }
};
