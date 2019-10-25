#include <Arduino.h>
#include <ESPmDNS.h>
#include <WiFiManager.h>            // development branch - https://github.com/tzapu/WiFiManager
#include "IrrigationController.h"

IrrigationController ic;
char hostname[18];

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  
  Serial.begin(115200);
  
  // WiFiManager, Local intialization. Once its business is done, there is no need to keep it around
  WiFiManager wm;

  // setup hostname
  String id = WiFi.macAddress();
  id.replace(":", "");
  id.toLowerCase();
  id = id.substring(6,12);
  id = "irrigation-" + id;
  id.toCharArray(hostname, 18);
  Serial.println(hostname);

  WiFi.mode(WIFI_STA); // explicitly set mode, esp defaults to STA+AP
  WiFi.config(INADDR_NONE, INADDR_NONE, INADDR_NONE);
  WiFi.setHostname(hostname);

  // wm.resetSettings();
 
  bool res;
  res = wm.autoConnect(hostname, "password"); // password protected ap

  if (!res) {
      Serial.println("Failed To Connect");
      // ESP.restart();
  } else {
      // if you get here you have connected to the WiFi    
      Serial.println("Connected To WiFi");
  }

  WiFi.setHostname(hostname);

  // start the irrigation controller
  ic.begin();

  // start mdns
  if (!MDNS.begin(hostname)) {
    Serial.println("Error setting up MDNS responder!");
    while(1) {
        delay(1000);
    }
  }
  Serial.println("mDNS responder started");

  MDNS.addService("oznu-platform", "tcp", 81);
  MDNS.addServiceTxt("oznu-platform", "tcp", "type", "irrigation-controller");
  MDNS.addServiceTxt("oznu-platform", "tcp", "mac", WiFi.macAddress());

  // turn off the secondary LED once the system is ready
  digitalWrite(LED_BUILTIN, LOW);
}

void loop() {
  ic.loopOne();
}
