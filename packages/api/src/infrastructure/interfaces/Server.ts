export interface Server {
  start(args: unknown): Promise<void>;
  stop(): Promise<void>;
}
