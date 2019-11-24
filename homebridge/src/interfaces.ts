export interface PluginConfig {
  platform: 'esp-irrigation-controller';
  name: string;
  activeSolenoids: number;
  activationDelay: number;
  programs: Array<{
    name: string;
    solenoids: string;
    subtype?: string;
  }>;
}