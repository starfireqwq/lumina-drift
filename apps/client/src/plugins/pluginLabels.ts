import type { Language } from '../locales';

const english = {
  menu: 'Plugins', manage: 'Manage Plugins…', import: 'Import Plugin…', sample: 'Download Sample',
  empty: 'No plugins installed.', noCommands: 'Enable a plugin to use its commands.',
  activate: 'Enable', deactivate: 'Disable', remove: 'Remove', replace: 'Replace Plugin',
  install: 'Install Plugin', cancel: 'Cancel', close: 'Close', needed: 'Open a canvas to run this command.',
  invalid: 'Could not import the plugin.', failed: 'Plugin could not complete the command.',
  done: 'Command completed', working: 'Running plugin…', scope: 'Plugin permissions',
  brush: 'Change brush color and size', layers: 'Create a raster layer', artwork: 'Add generated artwork as a new layer',
  noPermissions: 'This plugin can only display messages.',
  disabledInstall: 'The plugin will be installed disabled. Enable it here when you are ready to use it.',
  disabledReplace: 'This file replaces the installed plugin. The replacement starts disabled.',
};

const labels: Record<Language, typeof english> = {
  'en-US': english,
  'zh-TW': {
    menu: '插件', manage: '管理插件…', import: '匯入插件…', sample: '下載範例',
    empty: '尚未安裝插件。', noCommands: '啟用插件後，指令會顯示在這裡。',
    activate: '啟用', deactivate: '停用', remove: '移除', replace: '取代插件',
    install: '安裝插件', cancel: '取消', close: '關閉', needed: '請先開啟畫布，再執行插件。',
    invalid: '無法匯入插件。', failed: '插件未能完成指令。',
    done: '指令已完成', working: '正在執行插件…', scope: '插件權限',
    brush: '調整筆刷顏色與大小', layers: '新增點陣圖層', artwork: '將產生的圖案加入新圖層',
    noPermissions: '此插件只能顯示訊息。',
    disabledInstall: '安裝後預設停用，需要使用時可在這裡啟用。',
    disabledReplace: '這個檔案會取代已安裝的插件，新版本會先停用。',
  },
  'zh-CN': {
    menu: '插件', manage: '管理插件…', import: '导入插件…', sample: '下载示例',
    empty: '尚未安装插件。', noCommands: '启用插件后，命令会显示在这里。',
    activate: '启用', deactivate: '停用', remove: '移除', replace: '替换插件',
    install: '安装插件', cancel: '取消', close: '关闭', needed: '请先打开画布，再运行插件。',
    invalid: '无法导入插件。', failed: '插件未能完成命令。',
    done: '命令已完成', working: '正在运行插件…', scope: '插件权限',
    brush: '调整画笔颜色和大小', layers: '新建栅格图层', artwork: '将生成的图案添加到新图层',
    noPermissions: '此插件只能显示消息。',
    disabledInstall: '安装后默认停用，需要使用时可在这里启用。',
    disabledReplace: '此文件将替换已安装的插件，新版本会先停用。',
  },
  'ja-JP': {
    menu: 'プラグイン', manage: 'プラグインの管理…', import: 'プラグインを読み込む…', sample: 'サンプルをダウンロード',
    empty: 'インストール済みのプラグインはありません。', noCommands: '有効なプラグインのコマンドがここに表示されます。',
    activate: '有効にする', deactivate: '無効にする', remove: '削除', replace: '置き換える',
    install: 'インストール', cancel: 'キャンセル', close: '閉じる', needed: 'キャンバスを開いてから実行してください。',
    invalid: 'プラグインを読み込めませんでした。', failed: 'コマンドを実行できませんでした。',
    done: 'コマンドを実行しました', working: 'プラグインを実行中…', scope: 'プラグインの権限',
    brush: 'ブラシの色とサイズを変更', layers: 'ラスターレイヤーを作成', artwork: '生成した図形を新規レイヤーに追加',
    noPermissions: 'このプラグインはメッセージのみ表示できます。',
    disabledInstall: 'インストール直後は無効です。使用するにはここで有効にしてください。',
    disabledReplace: 'インストール済みのプラグインが置き換わり、新しいバージョンは無効になります。',
  },
};

export const getPluginLabels = (language: Language) => labels[language];
