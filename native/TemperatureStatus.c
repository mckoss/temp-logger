// Read-only AppleSMC temperature keys supplied by the per-chip whitelist.
// The SMC ABI is undocumented by Apple; only floating-point temperature keys are accepted.
#include <IOKit/IOKitLib.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
typedef struct { uint8_t major, minor, build, reserved; uint16_t release; } Version;
typedef struct { uint16_t version, length; uint32_t cpu, gpu, memory; } Limits;
typedef struct { uint32_t size, type; uint8_t attributes; } KeyInfo;
typedef struct {
  uint32_t key; Version version; Limits limits; KeyInfo info;
  uint8_t result, status, command; uint32_t index; uint8_t bytes[32];
} KeyData;
static int call(io_connect_t connection, KeyData *in, KeyData *out) {
  size_t size = sizeof(*out);
  return IOConnectCallStructMethod(connection, 2, in, sizeof(*in), out, &size) == KERN_SUCCESS && out->result == 0;
}
int main(int argc, char **argv) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
  if (!service) return 1;
  io_connect_t connection = 0;
  kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &connection);
  IOObjectRelease(service);
  if (result != KERN_SUCCESS) return 2;
  int count = 0;
  printf("{");
  for (int i = 1; i < argc; i++) {
    const unsigned char *key = (unsigned char *)argv[i];
    if (strlen(argv[i]) != 4 || key[0] != 'T') continue;
    KeyData in = {0}, out = {0};
    in.key = ((uint32_t)key[0] << 24) | ((uint32_t)key[1] << 16) | ((uint32_t)key[2] << 8) | key[3];
    in.command = 9;
    if (!call(connection, &in, &out) || out.info.type != 0x666c7420 || out.info.size != 4) continue;
    in.command = 5; in.info.size = 4; memset(&out, 0, sizeof(out));
    if (!call(connection, &in, &out)) continue;
    float temperature; memcpy(&temperature, out.bytes, sizeof(temperature));
    if (!isfinite(temperature) || temperature <= 0 || temperature > 130) continue;
    printf("%s\"%.4s\":%.6f", count++ ? "," : "", argv[i], temperature);
  }
  printf("}\n"); IOServiceClose(connection); return 0;
}
