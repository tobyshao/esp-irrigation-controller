
#include "Arduino.h"
#include <Preferences.h>
#include <ArduinoJson.h>       // v5.13.2 - https://github.com/bblanchon/ArduinoJson
#include <WebSocketsServer.h>  // v2.4.1 - https://github.com/Links2004/arduinoWebSockets

#include "IrrigationController.h"

IrrigationController::IrrigationController() {
  Serial.println("Loaded");
}

void IrrigationController::begin() {
  preferences.begin("relay-ctrl", false);

  // the array elements are numbered from 0 to (pinCount - 1).
  // use a for loop to initialize each pin as an output
  // ensure all pins are in the OFF state
  for (int thisPin = 0; thisPin < (sizeof(controlPins) / sizeof(controlPins[0])); thisPin++) {
    pinMode(controlPins[thisPin], OUTPUT);
    digitalWrite(controlPins[thisPin], OFF_STATE);
    pinState[controlPins[thisPin]] = 0;
  }

  // return the default duration / name for each relay and store it in memory
  for (int relay = 1; relay < (numRelaysEnabled + 1); relay++) {
    const char* durationKey = "dd-" + relay;
    defaultDuration[relay] = preferences.getUInt(durationKey, 300);
  }

  // start the websocket server
  webSocket.begin();
  webSocket.onEvent(std::bind(&IrrigationController::webSocketEvent, this, std::placeholders::_1, std::placeholders::_2, std::placeholders::_3, std::placeholders::_4));
}

void IrrigationController::loopOne () {
  webSocket.loop();
  this->offScheduler();

  // reboot the esp after x amount of time, if nothing no relays are on
  if (millis() > resetEspAt) {
    if (pinState[masterRelay] == 0) {
      Serial.println("Doing scheduled reboot of device in 5 seconds...");
      delay(5000);
      ESP.restart();
    }
  }
}

// capture web socket events
void IrrigationController::webSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.printf("[%u] Disconnected!\r\n", num);
      break;
    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(num);
      Serial.printf("[%u] Connected from %d.%d.%d.%d url: %s\n", num, ip[0], ip[1], ip[2], ip[3], payload);
      this->broadcastSystemStatus();
      break;
    }
    case WStype_TEXT: {
      // send the incoming request off for processing
      this->processIncomingRequest((char *)&payload[0]);
      break;
    }
    case WStype_BIN:
      Serial.printf("[%u] Got binary length: %u\r\n", num, length);
      break;
  }
}

// process the incoming request from a websocket message
void IrrigationController::processIncomingRequest(String payload) {
  DynamicJsonBuffer jsonBuffer;
  JsonObject& req = jsonBuffer.parseObject(payload);

  if ( req.containsKey("mode") && req["mode"] == "set" ) {
    if (req.containsKey("targetState") && req.containsKey("relay") &&  req.containsKey("duration") && req["targetState"] == 1) {
      if (req["relay"] > 0 && req["relay"] <= numRelaysEnabled) {
        this->turnOn(req["relay"], req["duration"]);
      }
    } else if (req.containsKey("targetState") && req.containsKey("relay") && req["targetState"] == 1) {
      if (req["relay"] > 0 && req["relay"] <= numRelaysEnabled) {
        this->turnOn(req["relay"]);
      }
    } else if (req.containsKey("targetState") && req.containsKey("relay") && req["targetState"] == 0) {
      if (req["relay"] > 0 && req["relay"] <= numRelaysEnabled) {
        this->turnOff(req["relay"]);
      }
    } else if (req.containsKey("defaultDuration") && req.containsKey("relay")) {
      this->setDefaultDuration(req["relay"], req["defaultDuration"]);
    }
  } else if ( req.containsKey("mode") && req["mode"] == "get" ) {
    this->broadcastSystemStatus();
  }
}

// run in the loop to check if any relays should be turned off
void IrrigationController::offScheduler() {
  // check if any relays should be turned off
  for (int relay = 1; relay < (sizeof(schedule) / sizeof(schedule[0])); relay++) {
    if ( schedule[relay] > 0 && schedule[relay] < millis() ) {
      Serial.print("On duration complete. Turning off #");
      Serial.println(relay);
      this->turnOff(relay);
    }
  }

  // check if we should shutdown
  if ( shutdownAt > 0 && shutdownAt < millis() ) {
    shutdownAt = 0;
    this->shutdownSystem();
  }
}

// returns the relays GPIO pin
int IrrigationController::getRelay(int relay) {
  return controlPins[relay - 1];
}

// turns on a relay for the specified duration
void IrrigationController::turnOn(int relay, int seconds) {
  digitalWrite(this->getRelay(relay), ON_STATE);
  this->turnOnMaster();
  pinState[relay] = 1;
  schedule[relay] = millis() + (seconds * 1000);
  shutdownAt = 0; // prevent the shutdown if another relay turns on

  // broadcast the state
  this->broadcastRelayStatus(relay, 1);
}

// turns on a relay for the default duration
void IrrigationController::turnOn(int relay) {
  digitalWrite(this->getRelay(relay), ON_STATE);
  this->turnOnMaster();
  pinState[relay] = 1;
  schedule[relay] = millis() + (defaultDuration[relay] * 1000);
  shutdownAt = 0; // prevent the shutdown if another relay turns on

  // broadcast the state
  this->broadcastRelayStatus(relay, 1);
}

// turns off a relay
void IrrigationController::turnOff(int relay) {
  digitalWrite(this->getRelay(relay), OFF_STATE);
  pinState[relay] = 0;
  schedule[relay] = 0;

  // of all solenoids are off start the shutdown countdown
  if (!this->anyActive()) {
    shutdownAt = millis() + shutdownTimer;
  }

  // broadcast the state
  this->broadcastRelayStatus(relay, 0);
}

// get the remaining run duration for a relay in seconds
int IrrigationController::getRemainingDuration(int relay) {
  int remaining = schedule[relay];
  if (remaining > 0) {
    remaining = (remaining - millis()) / 1000;
  }
  return remaining;
}

// set the default duration for a relay
void IrrigationController::setDefaultDuration(int relay, uint duration) {
  defaultDuration[relay] = duration;
  const char* durationKey = "dd-" + relay;
  preferences.putUInt(durationKey, duration);
}

// turns on the master relay
void IrrigationController::turnOnMaster() {
  digitalWrite(this->getRelay(masterRelay), ON_STATE);
  this->broadcastMasterStatus(1);
  pinState[masterRelay] = 1;
}

// turns on the master relay
void IrrigationController::turnOffMaster() {
  digitalWrite(this->getRelay(masterRelay), OFF_STATE);
}

// shutdown the system
// using delay will block incoming requests - which is what we want here
void IrrigationController::shutdownSystem() {
  if (!this->anyActive()) {
    Serial.println("Shutting down system...");
    
    pinState[masterRelay] = 2;
    this->broadcastMasterStatus(2);
    
    // turn off the master
    this->turnOffMaster();

    // wait a second
    delay(1000);

    // turn on the pressure relief relay
    digitalWrite(this->getRelay(pressureReliefRelay), ON_STATE);

    // keep it on for 5 seconds
    delay(5000);

    // turn off the pressure relief relay
    digitalWrite(this->getRelay(pressureReliefRelay), OFF_STATE);
    pinState[pressureReliefRelay] = 0;
    schedule[pressureReliefRelay] = 0;

    // broadcast system shutdown status
    pinState[masterRelay] = 0;
    this->broadcastMasterStatus(0);
  }
}

// check if any relays are active
bool IrrigationController::anyActive() {
  // check if all the relays are turned on / off
  bool status = false;
  for (int relay = 1; relay < (numRelaysEnabled + 1); relay++) {
    if (pinState[relay] == 1) {
      status = true;
      break;
    }
  }
  return status;
}

// broadcasts the current status of a relay to any listeners
void IrrigationController::broadcastRelayStatus(int relay, int status) {
  DynamicJsonBuffer jsonBuffer;
  JsonObject& res = jsonBuffer.createObject();

  res["type"] = "relay-status";
  res["relay"] = relay;
  res["status"] = status;
  res["defaultDuration"] = defaultDuration[relay];
  res["remainingDuration"] = this->getRemainingDuration(relay);

  String payload;
  res.printTo(payload);
  webSocket.broadcastTXT(payload);
}

// broadcasts the system status
void IrrigationController::broadcastMasterStatus(int status) {
  DynamicJsonBuffer jsonBuffer;
  JsonObject& res = jsonBuffer.createObject();

  res["type"] = "master-status";
  res["status"] = status;

  String payload;
  res.printTo(payload);
  webSocket.broadcastTXT(payload);
}

// broadcasts the status for everything
void IrrigationController::broadcastSystemStatus() {
  DynamicJsonBuffer jsonBuffer;
  JsonObject& res = jsonBuffer.createObject();

  res["type"] = "system-status";
  res["master"] = pinState[masterRelay];

  JsonArray& relays = res.createNestedArray("relays");

  for (int relay = 1; relay < (numRelaysEnabled + 1); relay++) {
    JsonObject& relayState = relays.createNestedObject();
    relayState["relay"] = relay;
    relayState["status"] = pinState[relay];
    relayState["defaultDuration"] = defaultDuration[relay];
    relayState["remainingDuration"] = this->getRemainingDuration(relay);
  }

  String payload;
  res.printTo(payload);
  webSocket.broadcastTXT(payload);
}