// Read-only AppleSMC input-rail estimate. The SMC ABI is undocumented by Apple.
// PD0R is described as DCIN/Adapter Rail Power in VirtualSMC's SMCSensorKeys.
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
int main(void) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
  if (!service) return 1;
  io_connect_t connection = 0;
  kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &connection);
  IOObjectRelease(service);
  if (result != KERN_SUCCESS) return 2;
  KeyData in = {0}, out = {0};
  in.key = 0x50443052; // PD0R; never sum unidentified rails or substitute PSTR's zero.
  in.command = 9;
  int ok = call(connection, &in, &out) && out.info.type == 0x666c7420 && out.info.size == 4;
  if (ok) {
    in.command = 5; in.info.size = 4;
    memset(&out, 0, sizeof(out));
    ok = call(connection, &in, &out);
  }
  IOServiceClose(connection);
  float watts = 0;
  memcpy(&watts, out.bytes, sizeof(watts));
  if (!ok || !isfinite(watts) || watts <= 0 || watts > 2000) {
    fprintf(stderr, "PD0R input-rail estimate unavailable\n"); return 3;
  }
  printf("%.6f\n", watts);
  return 0;
}
