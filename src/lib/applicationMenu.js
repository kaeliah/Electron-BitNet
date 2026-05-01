import path from 'path';
import {app, Menu, clipboard, shell} from 'electron';

/**
 * For configuring the electron window menu
 */
export function initApplicationMenu(mainWindow) {
    const openLocalApiDocs = () => {
      const docsPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'LOCAL_API.md')
        : path.join(app.getAppPath(), 'LOCAL_API.md');
      shell.openPath(docsPath);
    };

    const copyEndpoint = () => {
      clipboard.writeText('http://127.0.0.1:5273/v1/chat/completions');
    };

    const template = [
      {
        label: 'View',
        submenu: [
          {
            label: 'Send to tray',
            click() {
              mainWindow.minimize();
            }
          },
          { label: 'Reload', role: 'reload' },
          { label: 'Dev tools', role: 'toggleDevTools' }
        ]
      },
      {
        label: 'API',
        submenu: [
          {
            label: 'Copy Chat Endpoint',
            click() {
              copyEndpoint();
            }
          },
          {
            label: 'Open API Docs',
            click() {
              openLocalApiDocs();
            }
          }
        ]
      }
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
