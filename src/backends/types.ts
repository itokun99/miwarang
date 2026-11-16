export interface BackendResult {
  runId?: string;
  sessionId?: string;
  text?: string;
  state?: string;
  exitCode?: number;
  signal?: string | null;
  [key: string]: any;
}

export interface BackendAdapter {
  type?: string;
  listModels?(): any;
  runForeground(request: any): Promise<BackendResult>;
  start(request: any): Promise<BackendResult>;
  wait?(id: string): Promise<BackendResult>;
  cancel?(id: string): Promise<BackendResult>;
}
