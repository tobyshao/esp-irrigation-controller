import * as path from 'path';
import * as fs from 'fs-extra';
import * as dayjs from 'dayjs';
import * as Bonjour from 'bonjour';
import * as inflection from 'inflection';
import * as mdnsResolver from 'mdns-resolver';
import * as WebSocket from '@oznu/ws-connect';
import { PluginConfig } from './interfaces';

let Accessory, Service, Characteristic, UUIDGen;

export class Plugin {
  api: any;
  log: any;
  config: PluginConfig;
  accessories: any;
  activeAccessories: string[];
  cache: any;
  cachePath: string;

  constructor(log, config: PluginConfig, api, homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    this.api = api;
    this.log = log;
    this.config = config;
    this.accessories = {};
    this.activeAccessories = [];
    this.cache = {};
    this.cachePath = path.resolve(homebridge.user.storagePath(), 'accessories', 'esp-irrigation-controller.json');

    this.loadCache();

    const bonjour = Bonjour();
    const browser = bonjour.find({ type: 'oznu-platform' });

    browser.on('up', this.foundAccessory.bind(this));

    // Check bonjour again 5 seconds after launch
    setTimeout(() => {
      browser.update();
    }, 5000);

    // Check bonjour every 60 seconds
    setInterval(() => {
      browser.update();
    }, 60000);

    // Clean up missing thermostats if they are still not present after 72 hours
    setTimeout(() => {
      for (const [uuid, accessory] of Object.entries(this.accessories)) {
        if (!this.activeAccessories.includes(uuid)) {
          this.api.unregisterPlatformAccessories('homebridge-esp-irrigation-controller', 'esp-irrigation-controller', [accessory]);
        }
      }
    }, 72 * 3600000);
  }

  async foundAccessory(service) {
    if (service.txt.type && service.txt.type === 'irrigation-controller') {
      const UUID = UUIDGen.generate(service.txt.mac);
      const host = await mdnsResolver.resolve4(service.host);
      const accessoryConfig = { host, port: service.port, name: service.name, serial: service.txt.mac };

      // Mark the accessory as found so it will not be removed
      if (!this.activeAccessories.includes(UUID)) {
        this.activeAccessories.push(UUID);
      }

      if (!this.accessories[UUID]) {
        // New Accessory
        this.log(`Found new ESP Irrigation System at ${service.host}:${service.port} [${service.txt.mac}]`);
        this.accessories[UUID] = new Accessory(service.txt.mac.replace(/:/g, ''), UUID);
        this.startAccessory(this.accessories[UUID], accessoryConfig);
        this.api.registerPlatformAccessories(
          'homebridge-esp-irrigation-controller',
          'esp-irrigation-controller',
          [this.accessories[UUID]],
        );
      } else {
        // Existing Accessory
        this.log(`Found existing ESP Irrigation System at ${service.host}:${service.port} [${service.txt.mac}]`);
        this.startAccessory(this.accessories[UUID], accessoryConfig);
      }
    }
  }

  startAccessory(accessory, config) {
    const device = new IrrigationPlatformAccessory(this.log, this, accessory, config);
  }

  loadCache() {
    if (fs.existsSync(this.cachePath)) {
      try {
        this.cache = fs.readJsonSync(this.cachePath);
      } catch (e) {
        this.cache = {};
      }
    }
  }

  saveCache() {
    return fs.writeJson(this.cachePath, this.cache);
  }

}

class IrrigationPlatformAccessory {
  accessory: any;
  config: any;
  name: any;
  log: any;
  service: any;
  socket: any;
  plugin: Plugin;
  valveService: { [key: number]: IrrigationValveService } = {};
  programService = {};

  constructor(log, plugin: Plugin, accessory, config) {
    this.accessory = accessory;
    this.config = config;
    this.name = `${inflection.titleize(this.config.name.replace(/-/g, ' '))}`;
    this.log = (msg) => log(`[${this.name}] ${msg}`);
    this.plugin = plugin;

    if (!this.plugin.cache[this.name]) {
      this.plugin.cache[this.name] = {};
    }

    // Connect to web socket
    this.socket = new WebSocket(`ws://${this.config.host}:${this.config.port}`, {
      options: {
        handshakeTimeout: 2000,
      },
    });

    // Setup WebSocket Handlers
    this.socket.on('websocket-status', this.log);

    this.socket.on('json', this.parseStatus.bind(this));

    // Setup Base Service
    this.service = accessory.getService(Service.IrrigationSystem) ?
      accessory.getService(Service.IrrigationSystem) : accessory.addService(Service.IrrigationSystem, this.name);

    // Thermostat Accessory Information
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, 'Irrigation System')
      .setCharacteristic(Characteristic.Manufacturer, 'oznu-platform')
      .setCharacteristic(Characteristic.Model, 'esp-irrigation')
      .setCharacteristic(Characteristic.SerialNumber, config.serial);

    this.service.setCharacteristic(Characteristic.Name, 'Irrigation System');
    this.service.setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
    this.service.getCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE);
    this.service.setCharacteristic(Characteristic.ProgramMode, Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED);

    // activate the number of relays required
    for (let x = 1; x <= this.plugin.config.activeSolenoids; x++ ) {
      if (!this.plugin.cache[this.name][x]) {
        this.plugin.cache[this.name][x] = {
          configuredName: `Zone ${x}`,
        };
      }

      this.valveService[x] = new IrrigationValveService(this, this.accessory, {
        relay: x,
        name: `relay-${x}`,
      });
    }

    // check if we need to remove any solenoids (activeSolenoids count reduced for example)
    for (let x = this.plugin.config.activeSolenoids + 1; x <= 15; x++) {
      const existingService = accessory.services.find((service) => service.subtype === `relay-${x}`);
      if (existingService) {
        accessory.removeService(existingService);
        delete this.plugin.cache[this.name][x];
      }
    }

    // save cache
    this.plugin.saveCache();

    // create the program switch services
    if (this.plugin.config.programs) {
      for (const program of this.plugin.config.programs) {
        program.subtype = 'program-' + program.name.toLowerCase().replace(/ /g, '_');
        this.programService[program.subtype] = new ProgramSwitchService(this, this.accessory, program);
      }
    }

    // remove programs that no longer exist
    const stalePrograms = accessory.services.filter((service) => {
      if (service.subtype && service.subtype.startsWith('program-')) {
        if (this.plugin.config.programs) {
          return !this.plugin.config.programs.find((x) => service.subtype === 'program-' + x.name.toLowerCase().replace(/ /g, '_'));
        } else {
          return true;
        }
      } else {
        return false;
      }
    });

    for (const service of stalePrograms) {
      accessory.removeService(service);
    }
  }

  updateMaster(payload) {
    if (payload.status === 1) {
      this.service.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
      this.service.updateCharacteristic(Characteristic.InUse, Characteristic.InUse.IN_USE);
    } else if (payload.status === 2) {
      this.service.updateCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE);
    } else {
      this.service.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
      this.service.updateCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE);
    }
  }

  updateRelay(payload) {
    if (this.valveService[payload.relay]) {
      this.valveService[payload.relay].service.updateCharacteristic(Characteristic.Active, payload.status);
      this.valveService[payload.relay].service.updateCharacteristic(Characteristic.InUse, payload.status);
      this.valveService[payload.relay].service.updateCharacteristic(Characteristic.RemainingDuration, payload.remainingDuration);
      this.valveService[payload.relay].service.updateCharacteristic(Characteristic.SetDuration, payload.defaultDuration);
      this.valveService[payload.relay].scheduledOffTime = payload.remainingDuration ?
        dayjs().add(payload.remainingDuration, 'second').toDate() : null;
    }
  }

  parseStatus(payload) {
    if (payload.type === 'master-status') {
      this.updateMaster(payload);
    } else if (payload.type === 'relay-status') {
      this.updateRelay(payload);
    } else if (payload.type === 'system-status') {
      // update master
      this.updateMaster({
        status: payload.master,
      });
      // update each relay
      for (const relay of payload.relays) {
        this.updateRelay(relay);
      }
    }
  }
}

class IrrigationValveService {
  platform: IrrigationPlatformAccessory;
  accessory: any;
  config: any;
  log: any;
  service: any;
  scheduledOffTime: Date | null;

  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;
    this.log = platform.log;

    const subtype = inflection.camelize(config.name.replace(/ /g, '_'), true);

    this.service = accessory.getService(config.name) ?
      accessory.getService(config.name) : accessory.addService(Service.Valve, config.name, subtype);

    this.service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    this.service.setCharacteristic(Characteristic.Name, `Zone ${config.relay}`);
    this.service.setCharacteristic(Characteristic.ConfiguredName, this.platform.plugin.cache[this.platform.name][config.relay].configuredName);
    this.service.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
    this.service.setCharacteristic(Characteristic.InUse, Characteristic.InUse.NOT_IN_USE);
    this.service.setCharacteristic(Characteristic.RemainingDuration, 0);

    this.service.getCharacteristic(Characteristic.ConfiguredName)
      .on('set', this.setConfiguredNameHandler.bind(this));

    this.service.getCharacteristic(Characteristic.Active)
      .on('set', this.setActiveHandler.bind(this));

    this.service.getCharacteristic(Characteristic.SetDuration)
      .on('set', this.setSetDurationHandler.bind(this));

    this.service.getCharacteristic(Characteristic.RemainingDuration)
      .on('get', this.getRemainingDurationHandler.bind(this));
  }

  setConfiguredNameHandler(value, callback) {
    this.platform.plugin.cache[this.platform.name][this.config.relay].configuredName = value;
    this.service.updateCharacteristic(Characteristic.ConfiguredName, value);
    this.platform.plugin.saveCache();
    callback(null);
  }

  // set the valve to "Active"
  setActiveHandler(value, callback) {
    this.log(`calling setActiveHandler - ${value}`);
    this.platform.socket.sendJson({mode: 'set', targetState: value, relay: this.config.relay});
    callback(null);
  }

  // set the default duration for the valve - this is saved on the ESP's non-volatile storage
  setSetDurationHandler(value, callback) {
    this.platform.socket.sendJson({ mode: 'set', defaultDuration: value, relay: this.config.relay });
    this.log(`calling setSetDurationHandler - ${value}`);
    callback(null);
  }

  // calculate the remaining duration based on the last status update we got from the ESP
  getRemainingDurationHandler(callback) {
    if (this.scheduledOffTime) {
      const remaining = dayjs(this.scheduledOffTime).diff(dayjs(), 'second');
      if (remaining < 0) {
        callback(null, 0);
      } else {
        callback(null, remaining);
      }
    } else {
      callback(null, 0);
    }
  }
}

class ProgramSwitchService {
  platform: IrrigationPlatformAccessory;
  accessory: any;
  config: any;
  log: any;
  service: any;

  solenoids: number[];
  running: boolean = false;

  currentValve: number;
  currentJob: number[];
  currentTimeout;

  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;
    this.log = platform.log;

    this.service = accessory.getService(config.name) ?
      accessory.getService(config.name) : accessory.addService(Service.Switch, config.name, config.subtype);

    this.service.setCharacteristic(Characteristic.Name, config.name);

    this.service.getCharacteristic(Characteristic.On)
      .on('get', this.getOnHandler.bind(this))
      .on('set', this.setOnHandler.bind(this));

    this.solenoids = this.config.solenoids
      .split(',')
      .map(x => parseInt(x, 10))
      .filter(x => x <= this.platform.plugin.config.activeSolenoids && x > 0);
  }

  getOnHandler(callback) {
    callback(null, this.running);
  }

  setOnHandler(value: boolean, callback) {
    this.log(`calling setOnHandler`, value);
    if (!this.running && value) {
      this.running = true;
      this.startProgram();
    } else if (!value) {
      this.running = false;
      this.stopProgram();
    }
    callback(null);
  }

  stopProgram() {
    this.log(`[${this.config.name}] - Job Terminated`);
    // clear the timeout
    clearTimeout(this.currentTimeout);
    // turn off the current valve
    if (this.currentValve) {
      this.platform.valveService[this.currentValve].service.setCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
    }
    // empty the job
    this.currentJob = [];
  }

  startProgram() {
    this.log(`[${this.config.name}] - Starting Program`);
    this.currentJob = [...this.solenoids];
    if (this.currentJob.length) {
      this.nextRelay();
    } else {
      this.currentValve = null;
      this.currentTimeout = setTimeout(() => {
        this.log(`[${this.config.name}] - Program Finished`);
        this.service.updateCharacteristic(Characteristic.On, false);
      }, 1000);
    }
  }

  nextRelay() {
    this.currentValve = this.currentJob.shift();

    const duration = this.platform.valveService[this.currentValve].service.getCharacteristic(Characteristic.SetDuration).value;
    this.log(`[${this.config.name}] - Starting Relay ${this.currentValve} for ${duration} seconds.`);
    this.platform.valveService[this.currentValve].service.setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);

    if (this.currentJob.length) {
      // check if there are more relays to turn on with this program
      this.currentTimeout = setTimeout(() => {
        this.nextRelay();
      }, (duration + 1) * 1000);
    } else {
      // toggle the dummy switch off when all relays in the program have run
      this.currentTimeout = setTimeout(() => {
        this.currentValve = null;
        this.running = false;
        this.log(`[${this.config.name}] - Program Finished`);
        this.service.updateCharacteristic(Characteristic.On, false);
      }, (duration + 1) * 1000);
    }
  }

}