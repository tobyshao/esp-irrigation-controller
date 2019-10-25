#ifndef IrrigationController_h
#define IrrigationController_h

#include "Arduino.h"
#include <Preferences.h>
#include <ArduinoJson.h>       // v5.13.2 - https://github.com/bblanchon/ArduinoJson
#include <WebSocketsServer.h>  // v2.4.1 - https://github.com/Links2004/arduinoWebSockets

#include "settings.h"

class IrrigationController {
  public:
    WebSocketsServer webSocket = WebSocketsServer(81);
    Preferences preferences; 

    int controlPins[16] = {
      RELAY_1, RELAY_2, RELAY_3, RELAY_4, RELAY_5, RELAY_6, RELAY_7, RELAY_8,
      RELAY_9, RELAY_10, RELAY_11, RELAY_12, RELAY_13, RELAY_14, RELAY_15, RELAY_16
    };

    int pinState[17];
    unsigned long schedule[17];
    uint defaultDuration[17];

    // define which relay is the master
    // this relay will be turned on whenever another relay is turned on
    int masterRelay = 16;

    // the relay to use to relieve from the system after shutdown 
    int pressureReliefRelay = 1;

    // the number of relays to enable (max 15)
    int numRelaysEnabled = 15;

    // how long should the system wait before shutting down
    int shutdownTimer = 10000;

    // shutdown timer tracker
    unsigned long shutdownAt;

    // when should the esp be reset (every 30 days)
    unsigned long resetEspAt = (86400 * 30) * 1000;

    IrrigationController(void);
    void begin();
    void loopOne();
    void loopTwo();

    void webSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length);
    void processIncomingRequest(String payload);

    void offScheduler();
    int getRelay(int relay);
    void turnOn(int relay, int seconds);
    void turnOn(int relay);
    void turnOff(int relay);
    int getRemainingDuration(int relay);
    void setDefaultDuration(int relay, uint duration);
    void turnOnMaster();
    void turnOffMaster();
    void shutdownSystem();
    bool anyActive();

    void broadcastRelayStatus(int relay, int status);
    void broadcastMasterStatus(int status);
    void broadcastSystemStatus();
};

#endif