export interface LangWatchEnvironmentVariables {
  /** Self-hosted LangWatch base URL. When absent, the fake client is used. */
  langwatchEndpoint?: string;
  langwatchApiKey?: string;
}
