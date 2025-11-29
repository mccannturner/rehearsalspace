const { app, BrowserWindow } = require("electron");
const path = require("path");

let mainWindow;

function createWindow() {
    // Choose icon based on platform
    const iconPath =
        process.platform === "win32"
            ? path.join(__dirname, "assets", "rehearsal-space.ico")
            : path.join(__dirname, "assets", "rehearsal-space-1024.png");

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: "Rehearsal Space",
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Load the same server the browser uses
    mainWindow.loadURL("http://localhost:3000");

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    // On macOS it's common for apps to stay open until Cmd+Q quits explicitly
    if (process.platform !== "darwin") {
        app.quit();
    }
});
