#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// --- CONFIGURAÇÕES ---
const char* WIFI_SSID = "SEU_WIFI";
const char* WIFI_PASS = "SUA_SENHA";

// URLs do Convex (Instância Gateway)
const char* GW_TELEMETRY = "https://<SUA-URL-DO-CONVEX>.convex.cloud/gateway"; 
const char* GW_SITREP_REQ = "https://<SUA-URL-DO-CONVEX>.convex.cloud/sitrep-request"; 
const char* GW_SITREP_RES = "https://<SUA-URL-DO-CONVEX>.convex.cloud/sitrep-response"; 
const char* GATEWAY_PSK = "SUA_PSK_GATEWAY_AQUI";

// Configurações da Serial de Rádio (LoRa)
#define RXD2 16
#define TXD2 17

void setupWiFi() {
  Serial.print("Conectando ao Wi-Fi");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi Conectado!");
}

void sendTelemetryToCloud(String payloadJson) {
  if (WiFi.status() != WL_CONNECTED) return;

  int maxRetries = 3;
  int retryDelay = 2000;
  
  for (int i = 0; i < maxRetries; i++) {
    HTTPClient http;
    http.begin(GW_TELEMETRY);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Grid48-GW-Key", GATEWAY_PSK);

    int code = http.POST(payloadJson);
    if (code == 200) {
      Serial.printf("[HTTP] Telemetria entregue. OK.\n");
      http.end(); return;
    } else {
      Serial.printf("[HTTP] Erro %d\n", code);
      http.end();
      if (i < maxRetries - 1) {
        delay(retryDelay);
        retryDelay *= 2; // Backoff Exponencial
      }
    }
  }
}

void pollSitrepResponse(String requestId) {
  Serial.printf("[SITREP] Iniciando polling para %s\n", requestId.c_str());
  int maxAttempts = 12; // 2 minutos
  
  for (int i=0; i<maxAttempts; i++) {
    delay(10000); // Poll a cada 10s
    HTTPClient http;
    String url = String(GW_SITREP_RES) + "?request_id=" + requestId;
    http.begin(url);
    http.addHeader("X-Grid48-GW-Key", GATEWAY_PSK);
    
    int code = http.GET();
    if (code == 200) {
      String response = http.getString();
      Serial.printf("[SITREP] Resposta da IA: %s\n", response.c_str());
      // Aqui o gateway envia o valor de volta pelo Rádio (RF TX)
      http.end();
      return;
    } else if (code == 202) {
      Serial.println("[SITREP] IA ainda processando...");
    } else {
      Serial.printf("[SITREP] Erro no polling: %d\n", code);
    }
    http.end();
  }
  Serial.println("[SITREP] Timeout. IA não respondeu.");
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, RXD2, TXD2);
  setupWiFi();
  Serial.println("Grid 48 ESP32 Gateway Iniciado.");
}

void loop() {
  if (Serial2.available()) {
    // Na vida real: decodifica o Protobuf recebido via Serial2
    String raw = Serial2.readStringUntil('\n'); // Mock read
    
    // Simula telemetria desempacotada para mandar à nuvem
    StaticJsonDocument<200> doc;
    doc["node_id"] = "ESP32_GW_01";
    doc["packet_id"] = random(1000, 9999);
    doc["timestamp"] = millis() / 1000;
    doc["lat"] = -275953770;
    doc["lon"] = -485480500;
    doc["bitmask_status"] = 0;
    String json; serializeJson(doc, json);
    
    sendTelemetryToCloud(json);
  }
  delay(100);
}
