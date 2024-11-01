// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as path from 'path';
import * as util from './utils';
import { trace } from 'console';

export default class URDFPreview 
{
    private _resource: vscode.Uri;
    private _processing: boolean;
    private  _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _urdfEditor: vscode.TextEditor | null = null;
    _webview: vscode.WebviewPanel;
    private _trace: vscode.OutputChannel;

    public get state() {
        return {
            resource: this.resource.toString()
        };
    }

    public static create(
        context: vscode.ExtensionContext,
        resource: vscode.Uri,
        trace: vscode.OutputChannel
        ) : URDFPreview
    {
        // Create and show a new webview
        var editor = vscode.window.createWebviewPanel(
            'urdfPreview_standalone', // Identifies the type of the webview. Used internally
            'URDF Preview', // Title of the panel displayed to the user
            vscode.ViewColumn.Two, // Editor column to show the new webview panel in.
            { 
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        return new URDFPreview(editor, context, resource, trace);
    } 

    private constructor(
        webview: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        resource: vscode.Uri,
        trace: vscode.OutputChannel
    )
    {
        this._webview = webview;
        this._context = context;
        this._resource = resource;
        this._trace = trace;
        this._processing = false;

        let subscriptions: vscode.Disposable[] = [];

            // Set an event listener to listen for messages passed from the webview context
        this._setWebviewMessageListener(this._webview.webview);

        this._webview.webview.html = this._getWebviewContent(this._webview.webview, context.extensionUri);

        vscode.workspace.onDidSaveTextDocument(event => {

            if (event && this.isPreviewOf(event.uri)) {
                this.refresh();
            }
        }, this, this._context.subscriptions);

        this._webview.onDidDispose(() => {
            this.dispose();
        }, null, this._context.subscriptions);        

        vscode.workspace.onDidChangeConfiguration(event => {
            this.updateColors();
        }, this, this._context.subscriptions);


        this._disposables = subscriptions;
    }

    public get resource(): vscode.Uri {
        return this._resource;
    }

    public async refresh() {
        if (!this._processing) {
            this.loadResource();
        }
    }

    private updateColors() {
        if (this._webview) {
            const config = vscode.workspace.getConfiguration("urdf-editor");
            this._webview.webview.postMessage({ 
                command: 'colors', 
                cameraRadius: config.get("CameraDistanceToRobot", "1.0"),
                backgroundColor: config.get("BackgroundColor", "#000000"),
                gridLineColor: config.get("GridMinorColor", "#00FF00"),
                gridMainColor: config.get("GridMainColor", "#001100"),
                gridMinorOpacity: config.get("GridMinorOpacity", "0.4"),
                majorUnitFrequency: config.get("GridFrequency", "5"),
                gridRatio: config.get("GridRatio", "0.1"),
                debugUI: config.get("DebugUI", "false"),
            });
        }
    }

    private async loadResource() {
        this._processing = true;

        var packagesNotFound : any = [];
        var urdfText = "";
        try {
            urdfText = await util.xacro(this._resource.fsPath);

            var packageMap = await util.getPackages();
            if (packageMap !== null) {
                // replace package://(x) with fully resolved paths
                var pattern =  /package:\/\/(.*?)\//g;
                var match;
                while (match = pattern.exec(urdfText)) {
                    if (packageMap.hasOwnProperty(match[1]) === false) {
                        if (packagesNotFound.indexOf(match[1]) === -1) {
                            this._trace.appendLine(`Package ${match[1]} not found in workspace.`);
                            packagesNotFound.push(match[1]);
                        }
                    } else {
                        var packagePath = await packageMap[match[1]];
                        if (packagePath.charAt(0)  === '/') {
                            // inside of mesh re \source, the loader attempts to concatinate the base uri with the new path. It first checks to see if the
                            // base path has a /, if not it adds it.
                            // We are attempting to use a protocol handler as the base path - which causes this to fail.
                            // basepath - vscode-webview-resource:
                            // full path - /home/test/ros
                            // vscode-webview-resource://home/test/ros.
                            // It should be vscode-webview-resource:/home/test/ros.
                            // So remove the first char.

                            packagePath = packagePath.substr(1);
                        }
                        let normPath = path.normalize(packagePath);
                        let vsPath = vscode.Uri.file(normPath);
                        let newUri = this._webview.webview.asWebviewUri(vsPath);

                        urdfText = urdfText.replace('package://' + match[1], newUri.toString());
                    }
                }
            }

            var previewFile = this._resource.toString();

            this._trace.appendLine("URDF previewing: " + previewFile);
            this._trace.append(urdfText);

            this.updateColors();        

            this._webview.webview.postMessage({ command: 'previewFile', previewFile: this._resource.path});
            this._webview.webview.postMessage({ command: 'urdf', urdf: urdfText });

            this._processing = false;
        } catch (err : any) {
            vscode.window.showErrorMessage(err.message);
        }

        if (packagesNotFound.length > 0) {
            var packagesNotFoundList = packagesNotFound.join('\n');

            packagesNotFoundList += '\n\nNOTE: This version of the URDF Renderer will not look for packages outside the workspace.';
            vscode.window.showErrorMessage("The following packages were not found in the workspace:\n" + packagesNotFoundList);
        }
    }

    public static async revive(
        webview: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        trace: vscode.OutputChannel,
        state: any,
    ): Promise<URDFPreview> {
        const resource = vscode.Uri.file(state.previewFile);

        const preview = new URDFPreview(
            webview,
            context,
            resource,
            trace);

        return preview;
    }    

    public matchesResource(
        otherResource: vscode.Uri
    ): boolean {
        return this.isPreviewOf(otherResource);
    }

    public reveal() {
        this._webview.reveal(vscode.ViewColumn.Two);
    }    

    private isPreviewOf(resource: vscode.Uri): boolean {
        return this._resource.fsPath === resource.fsPath;
    }

    private readonly _onDisposeEmitter = new vscode.EventEmitter<void>();
    public readonly onDispose = this._onDisposeEmitter.event;    
    
    private readonly _onDidChangeViewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
    public readonly onDidChangeViewState = this._onDidChangeViewStateEmitter.event;

    public update(resource: vscode.Uri) {
        const editor = vscode.window.activeTextEditor;

        // If we have changed resources, cancel any pending updates
        const isResourceChange = resource.fsPath !== this._resource.fsPath;
        this._resource = resource;
        // Schedule update if none is pending
        this.refresh();
    }
    
    public dispose() {
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }

        this._onDisposeEmitter.fire();
        this._onDisposeEmitter.dispose();

        this._onDidChangeViewStateEmitter.dispose();
        this._webview.dispose();    
    }


    /**
   * Defines and returns the HTML that should be rendered within the webview panel.
   *
   * @remarks This is also the place where *references* to CSS and JavaScript files
   * are created and inserted into the webview HTML.
   *
   * @param webview A reference to the extension webview
   * @param extensionUri The URI of the directory containing the extension
   * @returns A template string literal containing the HTML that should be
   * rendered within the webview panel
   */
    private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri) {
        const webviewUri = this.getUri(webview, extensionUri, ["dist", "webview.js"]);
        const webviewUriUrdf = this.getUri(webview, extensionUri, ["node_modules/@polyhobbyist/babylon_ros/dist", "ros.js"]);
        const webviewUriBabylon = this.getUri(webview, extensionUri, ["node_modules/babylonjs", "babylon.max.js"]);
        const nonce = util.getNonce();

        // Tip: Install the es6-string-html VS Code extension to enable code highlighting below
        return /*html*/ `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style nonce="${nonce}">
                html,
                body {
                overflow: hidden;
                width: 100%;
                height: 100%;
                margin: 0;
                padding: 0;
                }

                #renderCanvas {
                width: 100%;
                height: 100%;
                touch-action: none;
                }
            </style>
            <title>URDF Preview</title>
            </head>
            <body>
                <canvas id="renderCanvas" touch-action="none"></canvas>    
                <script type="module" nonce="${nonce}" src="${webviewUriBabylon}"></script>
                <script type="module" nonce="${nonce}" src="${webviewUri}"></script>
            </body>
            </html>
        `;
    }

    private getUri(webview: vscode.Webview, extensionUri: vscode.Uri, pathList: string[]) {
        return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathList));
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
        (message: any) => {
            const command = message.command;
            const text = message.text;
    
            switch (command) {
            case "info":
                vscode.window.showInformationMessage(text);
                return;
            case "error":
                vscode.window.showErrorMessage(text);
                return;
            case "trace":
                this._trace.appendLine(text);
                return;
            case "ready":
                this.refresh();
                return;
            }
        },
        undefined,
        this._disposables
        );
    }
    }
