/**
 * Homebridge Entry Point
 */

import { PluginConfig } from './interfaces';
import { Plugin } from './main';

let homebridge;

export = (api) => {
  homebridge = api;
  homebridge.registerPlatform(
    'homebridge-esp-irrigation-controller',
    'esp-irrigation-controller',
    HomebridgeEsp32IrrigationSystemController,
  );
};

class HomebridgeEsp32IrrigationSystemController{

  private log;
  private config;
  private plugin;

  constructor(log, config: PluginConfig, api) {
    this.log = log;
    this.config = config;

    if (this.config.platform) {
      this.plugin = new Plugin(this.log, this.config, api, homebridge);
    }
  }

  // Called when a cached accessory is loaded
  configureAccessory(accessory) {
    this.plugin.accessories[accessory.UUID] = accessory;
  }

}