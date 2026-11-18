(() => {
  const call = (action, payload = {}) => {
    const response = JSON.parse(prompt('lumina:' + JSON.stringify({ action, ...payload })) || '{}');
    if (response.error) throw new Error(response.error);
    return response;
  };
  let beforeClose;
  let saving = false;
  const save = async (blob, payload) => {
    if (saving) throw new Error('請等待目前的檔案儲存完成。');
    saving = true;
    try {
      call('begin');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      for (let start = 0; start < bytes.length; start += 32768) {
        const chunk = bytes.subarray(start, start + 32768);
        call('chunk', { data: btoa(String.fromCharCode(...chunk)) });
      }
      return call('save', payload);
    } finally {
      call('discard');
      saving = false;
    }
  };
  window.atelierMobile = {
    isAndroid: true,
    getStorageDirectory: async () => call('storage').path,
    saveLuminaFile: async ({ data, ...payload }) => save(new Blob([data]), payload),
    onBeforeClose(callback) {
      beforeClose = callback;
      return () => { if (beforeClose === callback) beforeClose = undefined; };
    },
  };
  window.addEventListener('lumina-prepare-close', async () => {
    try {
      await beforeClose?.();
      call('close');
    } catch (error) {
      call('close', { error: error instanceof Error ? error.message : String(error) });
    }
  });
  document.addEventListener('click', async (event) => {
    const anchor = event.target.closest?.('a[download]');
    if (!anchor || !/^(blob:|data:)/.test(anchor.href)) return;
    event.preventDefault();
    try {
      const response = await fetch(anchor.href);
      await save(await response.blob(), { defaultName: anchor.download || 'artwork.png' });
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }, true);
})();
