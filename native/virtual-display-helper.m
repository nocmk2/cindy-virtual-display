#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <signal.h>
#import <stdio.h>
#import <unistd.h>

@interface CGVirtualDisplayMode : NSObject
@property (readonly, nonatomic) unsigned int width;
@property (readonly, nonatomic) unsigned int height;
@property (readonly, nonatomic) double refreshRate;
- (instancetype)initWithWidth:(unsigned int)width
                       height:(unsigned int)height
                  refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property (nonatomic) unsigned int hiDPI;
@property (nonatomic) unsigned int rotation;
@property (strong, nonatomic) NSArray<CGVirtualDisplayMode *> *modes;
@end

@interface CGVirtualDisplayDescriptor : NSObject
@property (nonatomic) unsigned int vendorID;
@property (nonatomic) unsigned int productID;
@property (nonatomic) unsigned int serialNum;
@property (strong, nonatomic) NSString *name;
@property (nonatomic) CGSize sizeInMillimeters;
@property (nonatomic) unsigned int maxPixelsWide;
@property (nonatomic) unsigned int maxPixelsHigh;
@property (nonatomic) CGPoint redPrimary;
@property (nonatomic) CGPoint greenPrimary;
@property (nonatomic) CGPoint bluePrimary;
@property (nonatomic) CGPoint whitePoint;
@property (strong, nonatomic) dispatch_queue_t queue;
@property (copy, nonatomic) void (^terminationHandler)(id, id);
@end

@interface CGVirtualDisplay : NSObject
@property (readonly, nonatomic) CGDirectDisplayID displayID;
@property (readonly, nonatomic) unsigned int vendorID;
@property (readonly, nonatomic) unsigned int productID;
@property (readonly, nonatomic) unsigned int serialNum;
@property (readonly, nonatomic) NSString *name;
@property (readonly, nonatomic) unsigned int maxPixelsWide;
@property (readonly, nonatomic) unsigned int maxPixelsHigh;
@property (readonly, nonatomic) unsigned int hiDPI;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

@interface ManagedDisplayEntry : NSObject
@property (copy, nonatomic) NSString *handleId;
@property (copy, nonatomic) NSString *name;
@property (nonatomic) unsigned int width;
@property (nonatomic) unsigned int height;
@property (nonatomic) double refreshRate;
@property (nonatomic) BOOL hiDPI;
@property (nonatomic) unsigned int maxPixelsWide;
@property (nonatomic) unsigned int maxPixelsHigh;
@property (nonatomic) CGDirectDisplayID displayID;
@property (nonatomic) double createdAt;
@property (strong, nonatomic) CGVirtualDisplay *display;
@end

@implementation ManagedDisplayEntry
@end

static NSMutableDictionary<NSString *, ManagedDisplayEntry *> *gManaged = nil;
static NSUInteger gSequence = 0;
static dispatch_queue_t gOutputQueue = nil;
static dispatch_queue_t gStateQueue = nil;
static dispatch_queue_t gDisplayEventQueue = nil;

static void writeJSONLine(NSDictionary *payload) {
    dispatch_sync(gOutputQueue, ^{
        NSError *err = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&err];
        if (!data || err) return;
        fwrite(data.bytes, 1, data.length, stdout);
        fputc('\n', stdout);
        fflush(stdout);
    });
}

static NSDictionary<NSNumber *, NSString *> *screenNamesByID(void) {
    NSMutableDictionary<NSNumber *, NSString *> *names = [NSMutableDictionary dictionary];
    for (NSScreen *screen in [NSScreen screens]) {
        NSNumber *num = screen.deviceDescription[@"NSScreenNumber"];
        if (num && screen.localizedName.length > 0) {
            names[num] = screen.localizedName;
        }
    }
    return names;
}

static NSArray<NSDictionary *> *collectOnlineDisplays(void) {
    NSDictionary<NSNumber *, NSString *> *screenNames = screenNamesByID();
    NSMutableDictionary<NSNumber *, ManagedDisplayEntry *> *managedByDisplayID = [NSMutableDictionary dictionary];
    for (ManagedDisplayEntry *entry in gManaged.allValues) {
        if (entry.displayID != 0) {
            managedByDisplayID[@(entry.displayID)] = entry;
        }
    }

    uint32_t maxDisplays = 32;
    CGDirectDisplayID displayIDs[32];
    uint32_t displayCount = 0;
    CGError err = CGGetOnlineDisplayList(maxDisplays, displayIDs, &displayCount);
    if (err != kCGErrorSuccess) {
        return @[];
    }

    NSMutableArray<NSDictionary *> *result = [NSMutableArray arrayWithCapacity:displayCount];
    for (uint32_t i = 0; i < displayCount; i++) {
        CGDirectDisplayID did = displayIDs[i];
        CGDisplayModeRef mode = CGDisplayCopyDisplayMode(did);
        size_t logicalW = CGDisplayPixelsWide(did);
        size_t logicalH = CGDisplayPixelsHigh(did);
        size_t pixelW = mode ? CGDisplayModeGetPixelWidth(mode) : logicalW;
        size_t pixelH = mode ? CGDisplayModeGetPixelHeight(mode) : logicalH;
        double refresh = mode ? CGDisplayModeGetRefreshRate(mode) : 0.0;
        if (mode) CGDisplayModeRelease(mode);

        CGRect bounds = CGDisplayBounds(did);
        ManagedDisplayEntry *managed = managedByDisplayID[@(did)];
        NSString *name = managed ? managed.name : (screenNames[@(did)] ?: [NSString stringWithFormat:@"Display %u", did]);

        NSMutableDictionary *item = [NSMutableDictionary dictionaryWithDictionary:@{
            @"displayID": @(did),
            @"name": name,
            @"width": @(logicalW),
            @"height": @(logicalH),
            @"pixelWidth": @(pixelW),
            @"pixelHeight": @(pixelH),
            @"refreshRate": @(refresh > 0 ? refresh : 60.0),
            @"hiDPI": @((BOOL)(pixelW > logicalW || pixelH > logicalH)),
            @"isMain": @((BOOL)(CGDisplayIsMain(did) != 0)),
            @"isBuiltin": @((BOOL)(CGDisplayIsBuiltin(did) != 0)),
            @"isManagedVirtual": @((BOOL)(managed != nil)),
            @"vendorNumber": @(CGDisplayVendorNumber(did)),
            @"modelNumber": @(CGDisplayModelNumber(did)),
            @"originX": @((NSInteger)llround(bounds.origin.x)),
            @"originY": @((NSInteger)llround(bounds.origin.y)),
        }];
        if (managed) {
            item[@"handleId"] = managed.handleId;
        }
        [result addObject:item];
    }
    return result;
}

static NSArray<NSDictionary *> *collectManagedDisplays(void) {
    NSArray<NSString *> *keys = [gManaged.allKeys sortedArrayUsingSelector:@selector(compare:)];
    NSMutableArray<NSDictionary *> *list = [NSMutableArray arrayWithCapacity:keys.count];
    for (NSString *key in keys) {
        ManagedDisplayEntry *entry = gManaged[key];
        [list addObject:@{
            @"handleId": entry.handleId,
            @"displayID": @(entry.displayID),
            @"name": entry.name,
            @"width": @(entry.width),
            @"height": @(entry.height),
            @"refreshRate": @(entry.refreshRate),
            @"hiDPI": @(entry.hiDPI),
            @"createdAt": @(entry.createdAt),
        }];
    }
    return list;
}

static BOOL virtualDisplayAPIAvailable(void) {
    return objc_getClass("CGVirtualDisplay") != Nil &&
           objc_getClass("CGVirtualDisplayDescriptor") != Nil &&
           objc_getClass("CGVirtualDisplayMode") != Nil &&
           objc_getClass("CGVirtualDisplaySettings") != Nil;
}

static CGVirtualDisplaySettings *buildSettings(unsigned int width,
                                               unsigned int height,
                                               double refreshRate,
                                               BOOL hiDPI) {
    Class modeCls = objc_getClass("CGVirtualDisplayMode");
    Class settingsCls = objc_getClass("CGVirtualDisplaySettings");
    CGVirtualDisplaySettings *settings = [[settingsCls alloc] init];
    settings.hiDPI = hiDPI ? 1 : 0;
    settings.rotation = 0;

    NSMutableArray<CGVirtualDisplayMode *> *modes = [NSMutableArray array];
    CGVirtualDisplayMode *primary = [[modeCls alloc] initWithWidth:width height:height refreshRate:refreshRate];
    if (primary) {
        [modes addObject:primary];
    }
    if (hiDPI && width * 2 <= 7680 && height * 2 <= 4320) {
        CGVirtualDisplayMode *scaled2x = [[modeCls alloc] initWithWidth:width * 2 height:height * 2 refreshRate:refreshRate];
        if (scaled2x) {
            [modes addObject:scaled2x];
        }
    }
    // Include safe fallback 1920x1080 if primary differs and fits.
    if (width != 1920 || height != 1080) {
        CGVirtualDisplayMode *fallback = [[modeCls alloc] initWithWidth:1920 height:1080 refreshRate:60.0];
        if (fallback) {
            [modes addObject:fallback];
        }
    }
    settings.modes = modes;
    return settings;
}

static void selectBestDisplayMode(CGDirectDisplayID displayID,
                                  unsigned int width,
                                  unsigned int height,
                                  double refreshRate,
                                  BOOL hiDPI) {
    NSDictionary *opts = @{ (__bridge NSString *)kCGDisplayShowDuplicateLowResolutionModes: @YES };
    for (int attempt = 0; attempt < 5; attempt++) {
        CFArrayRef allModes = CGDisplayCopyAllDisplayModes(displayID, (__bridge CFDictionaryRef)opts);
        if (allModes) {
            CFIndex count = CFArrayGetCount(allModes);
            CGDisplayModeRef exactMatch = NULL;
            CGDisplayModeRef sizeMatch = NULL;
            double exactRateDiff = 1e9;
            double sizeRateDiff = 1e9;

            size_t wantPixelW = hiDPI ? (size_t)width * 2 : (size_t)width;
            size_t wantPixelH = hiDPI ? (size_t)height * 2 : (size_t)height;

            for (CFIndex i = 0; i < count; i++) {
                CGDisplayModeRef m = (CGDisplayModeRef)CFArrayGetValueAtIndex(allModes, i);
                size_t lw = CGDisplayModeGetWidth(m);
                size_t lh = CGDisplayModeGetHeight(m);
                if (lw != width || lh != height) continue;

                size_t pw = CGDisplayModeGetPixelWidth(m);
                size_t ph = CGDisplayModeGetPixelHeight(m);
                double hz = CGDisplayModeGetRefreshRate(m);
                double diff = fabs((hz > 0 ? hz : 60.0) - refreshRate);

                if (pw == wantPixelW && ph == wantPixelH) {
                    if (!exactMatch || diff < exactRateDiff) {
                        exactMatch = m;
                        exactRateDiff = diff;
                    }
                } else if (!sizeMatch || diff < sizeRateDiff) {
                    sizeMatch = m;
                    sizeRateDiff = diff;
                }
            }

            CGDisplayModeRef chosen = exactMatch ?: sizeMatch;
            if (chosen) {
                CGError err = CGDisplaySetDisplayMode(displayID, chosen, NULL);
                CFRelease(allModes);
                if (err == kCGErrorSuccess) return;
            } else {
                CFRelease(allModes);
            }
        }
        usleep(100000); // wait 100ms for CoreGraphics to finish exposing modes
    }
}

static NSDictionary *createVirtualDisplay(NSString *name,
                                          unsigned int width,
                                          unsigned int height,
                                          double refreshRate,
                                          BOOL hiDPI,
                                          unsigned int explicitSerial,
                                          NSString *reuseHandleId) {
    if (!virtualDisplayAPIAvailable()) {
        return @{ @"ok": @NO, @"error": @"CGVirtualDisplay API is unavailable on this macOS version." };
    }
    if (width < 640 || width > 7680 || height < 480 || height > 4320) {
        return @{ @"ok": @NO, @"error": @"Resolution must be between 640x480 and 7680x4320." };
    }
    if (refreshRate < 24.0 || refreshRate > 240.0) {
        return @{ @"ok": @NO, @"error": @"Refresh rate must be between 24 and 240 Hz." };
    }

    gSequence += 1;
    NSString *handleId = reuseHandleId ?: [NSString stringWithFormat:@"vd-%lu", (unsigned long)gSequence];

    unsigned int requiredMaxW = hiDPI ? MIN(width * 2, 7680) : width;
    unsigned int requiredMaxH = hiDPI ? MIN(height * 2, 4320) : height;
    unsigned int maxW = MAX(requiredMaxW, 5120);
    unsigned int maxH = MAX(requiredMaxH, 2880);
    if (maxW > 7680) maxW = 7680;
    if (maxH > 4320) maxH = 4320;

    unsigned int serial = explicitSerial > 0 ? explicitSerial : (unsigned int)(0xC1D00000u + (unsigned int)gSequence);
    Class descCls = objc_getClass("CGVirtualDisplayDescriptor");
    Class dispCls = objc_getClass("CGVirtualDisplay");
    CGVirtualDisplayDescriptor *desc = [[descCls alloc] init];
    desc.vendorID = 0x1E6D;
    desc.productID = (unsigned int)(0x5B10 + (serial & 0xFF));
    desc.serialNum = serial;
    desc.name = name.length > 0 ? name : @"Cindy Virtual Display";
    desc.maxPixelsWide = maxW;
    desc.maxPixelsHigh = maxH;
    double ppi = hiDPI ? 110.0 : 96.0;
    desc.sizeInMillimeters = CGSizeMake(25.4 * (double)width / ppi, 25.4 * (double)height / ppi);
    desc.redPrimary = CGPointMake(0.6400, 0.3300);
    desc.greenPrimary = CGPointMake(0.3000, 0.6000);
    desc.bluePrimary = CGPointMake(0.1500, 0.0600);
    desc.whitePoint = CGPointMake(0.3127, 0.3290);
    desc.queue = gDisplayEventQueue;

    NSString *capturedHandle = [handleId copy];
    desc.terminationHandler = ^(id disp, id error) {
        (void)disp;
        (void)error;
        dispatch_async(gStateQueue, ^{
            ManagedDisplayEntry *existing = gManaged[capturedHandle];
            if (existing) {
                CGDirectDisplayID did = existing.displayID;
                [gManaged removeObjectForKey:capturedHandle];
                writeJSONLine(@{
                    @"event": @"terminated",
                    @"handleId": capturedHandle,
                    @"displayID": @(did),
                });
            }
        });
    };

    CGVirtualDisplay *display = [[dispCls alloc] initWithDescriptor:desc];
    if (!display || display.displayID == 0) {
        return @{ @"ok": @NO, @"error": @"Failed to initialize CGVirtualDisplay (ensure a macOS GUI session is active)." };
    }

    CGVirtualDisplaySettings *settings = buildSettings(width, height, refreshRate, hiDPI);
    BOOL applied = [display applySettings:settings];
    if (!applied) {
        return @{ @"ok": @NO, @"error": @"CGVirtualDisplay was created but applySettings failed." };
    }
    selectBestDisplayMode(display.displayID, width, height, refreshRate, hiDPI);

    ManagedDisplayEntry *entry = [[ManagedDisplayEntry alloc] init];
    entry.handleId = handleId;
    entry.name = desc.name;
    entry.width = width;
    entry.height = height;
    entry.refreshRate = refreshRate;
    entry.hiDPI = hiDPI;
    entry.maxPixelsWide = maxW;
    entry.maxPixelsHigh = maxH;
    entry.displayID = display.displayID;
    entry.createdAt = [[NSDate date] timeIntervalSince1970];
    entry.display = display;

    gManaged[handleId] = entry;

    return @{
        @"ok": @YES,
        @"display": @{
            @"handleId": entry.handleId,
            @"displayID": @(entry.displayID),
            @"name": entry.name,
            @"width": @(entry.width),
            @"height": @(entry.height),
            @"refreshRate": @(entry.refreshRate),
            @"hiDPI": @(entry.hiDPI),
            @"createdAt": @(entry.createdAt),
        },
        @"managed": collectManagedDisplays(),
        @"displays": collectOnlineDisplays(),
    };
}

static NSDictionary *handleCommand(NSDictionary *req) {
    NSString *cmd = [req[@"cmd"] isKindOfClass:[NSString class]] ? req[@"cmd"] : @"";
    if ([cmd isEqualToString:@"ping"]) {
        return @{
            @"ok": @YES,
            @"pid": @(getpid()),
            @"apiAvailable": @(virtualDisplayAPIAvailable()),
        };
    }
    if ([cmd isEqualToString:@"list"] || [cmd isEqualToString:@"status"]) {
        return @{
            @"ok": @YES,
            @"pid": @(getpid()),
            @"apiAvailable": @(virtualDisplayAPIAvailable()),
            @"managed": collectManagedDisplays(),
            @"displays": collectOnlineDisplays(),
        };
    }
    if ([cmd isEqualToString:@"create"]) {
        NSString *name = [req[@"name"] isKindOfClass:[NSString class]] ? req[@"name"] : @"Cindy Virtual Display";
        unsigned int width = [req[@"width"] isKindOfClass:[NSNumber class]] ? [req[@"width"] unsignedIntValue] : 1920;
        unsigned int height = [req[@"height"] isKindOfClass:[NSNumber class]] ? [req[@"height"] unsignedIntValue] : 1080;
        double refreshRate = [req[@"refreshRate"] isKindOfClass:[NSNumber class]] ? [req[@"refreshRate"] doubleValue] : 60.0;
        BOOL hiDPI = [req[@"hiDPI"] isKindOfClass:[NSNumber class]] ? [req[@"hiDPI"] boolValue] : YES;
        unsigned int serialNum = [req[@"serialNum"] isKindOfClass:[NSNumber class]] ? [req[@"serialNum"] unsignedIntValue] : 0;
        return createVirtualDisplay(name, width, height, refreshRate, hiDPI, serialNum, nil);
    }
    if ([cmd isEqualToString:@"update"]) {
        NSString *handleId = [req[@"handleId"] isKindOfClass:[NSString class]] ? req[@"handleId"] : nil;
        if (!handleId || !gManaged[handleId]) {
            return @{ @"ok": @NO, @"error": @"Unknown handleId." };
        }
        ManagedDisplayEntry *entry = gManaged[handleId];
        unsigned int width = [req[@"width"] isKindOfClass:[NSNumber class]] ? [req[@"width"] unsignedIntValue] : entry.width;
        unsigned int height = [req[@"height"] isKindOfClass:[NSNumber class]] ? [req[@"height"] unsignedIntValue] : entry.height;
        double refreshRate = [req[@"refreshRate"] isKindOfClass:[NSNumber class]] ? [req[@"refreshRate"] doubleValue] : entry.refreshRate;
        BOOL hiDPI = [req[@"hiDPI"] isKindOfClass:[NSNumber class]] ? [req[@"hiDPI"] boolValue] : entry.hiDPI;
        NSString *name = [req[@"name"] isKindOfClass:[NSString class]] && [req[@"name"] length] > 0 ? req[@"name"] : entry.name;

        unsigned int requiredW = hiDPI ? MIN(width * 2, 7680) : width;
        unsigned int requiredH = hiDPI ? MIN(height * 2, 4320) : height;

        // If same name and fits within existing maxPixels, apply settings in-place; otherwise recreate cleanly.
        if ([name isEqualToString:entry.name] && requiredW <= entry.maxPixelsWide && requiredH <= entry.maxPixelsHigh) {
            CGVirtualDisplaySettings *settings = buildSettings(width, height, refreshRate, hiDPI);
            if ([entry.display applySettings:settings]) {
                selectBestDisplayMode(entry.displayID, width, height, refreshRate, hiDPI);
                entry.width = width;
                entry.height = height;
                entry.refreshRate = refreshRate;
                entry.hiDPI = hiDPI;
                return @{
                    @"ok": @YES,
                    @"display": @{
                        @"handleId": entry.handleId,
                        @"displayID": @(entry.displayID),
                        @"name": entry.name,
                        @"width": @(entry.width),
                        @"height": @(entry.height),
                        @"refreshRate": @(entry.refreshRate),
                        @"hiDPI": @(entry.hiDPI),
                        @"createdAt": @(entry.createdAt),
                    },
                    @"managed": collectManagedDisplays(),
                    @"displays": collectOnlineDisplays(),
                };
            }
        }
        // Recreate under the same handleId after giving WindowServer a moment to release the old display
        [gManaged removeObjectForKey:handleId];
        usleep(150000);
        return createVirtualDisplay(name, width, height, refreshRate, hiDPI, 0, handleId);
    }
    if ([cmd isEqualToString:@"destroy"]) {
        BOOL destroyAll = [req[@"all"] isKindOfClass:[NSNumber class]] && [req[@"all"] boolValue];
        NSString *handleId = [req[@"handleId"] isKindOfClass:[NSString class]] ? req[@"handleId"] : nil;
        NSUInteger removed = 0;
        if (destroyAll) {
            removed = gManaged.count;
            [gManaged removeAllObjects];
        } else if (handleId && gManaged[handleId]) {
            [gManaged removeObjectForKey:handleId];
            removed = 1;
        } else {
            return @{ @"ok": @NO, @"error": @"Specify a valid handleId or set all=true." };
        }
        return @{
            @"ok": @YES,
            @"removed": @(removed),
            @"managed": collectManagedDisplays(),
            @"displays": collectOnlineDisplays(),
        };
    }
    return @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"Unknown command: %@", cmd] };
}

static void handleSignal(int sig) {
    (void)sig;
    _exit(0);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        gManaged = [NSMutableDictionary dictionary];
        gOutputQueue = dispatch_queue_create("cindy.vdisplay.out", DISPATCH_QUEUE_SERIAL);
        gStateQueue = dispatch_queue_create("cindy.vdisplay.state", DISPATCH_QUEUE_SERIAL);
        gDisplayEventQueue = dispatch_queue_create("cindy.vdisplay.events", DISPATCH_QUEUE_SERIAL);

        BOOL listOnly = NO;
        BOOL daemonMode = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--list") == 0) listOnly = YES;
            if (strcmp(argv[i], "--daemon") == 0) daemonMode = YES;
        }

        if (listOnly && !daemonMode) {
            writeJSONLine(@{
                @"ok": @YES,
                @"pid": @(getpid()),
                @"apiAvailable": @(virtualDisplayAPIAvailable()),
                @"displays": collectOnlineDisplays(),
            });
            return 0;
        }

        signal(SIGTERM, handleSignal);
        signal(SIGINT, handleSignal);
        signal(SIGPIPE, SIG_IGN);

        // Notify parent we are ready
        writeJSONLine(@{
            @"event": @"ready",
            @"pid": @(getpid()),
            @"apiAvailable": @(virtualDisplayAPIAvailable()),
        });

        char *lineBuf = NULL;
        size_t lineCap = 0;
        ssize_t lineLen = 0;
        while ((lineLen = getline(&lineBuf, &lineCap, stdin)) > 0) {
            @autoreleasepool {
                while (lineLen > 0 && (lineBuf[lineLen - 1] == '\n' || lineBuf[lineLen - 1] == '\r')) {
                    lineLen--;
                }
                if (lineLen == 0) continue;
                NSData *lineData = [NSData dataWithBytesNoCopy:lineBuf length:(NSUInteger)lineLen freeWhenDone:NO];
                NSError *parseErr = nil;
                id parsed = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:&parseErr];
                if (![parsed isKindOfClass:[NSDictionary class]] || parseErr) {
                    writeJSONLine(@{ @"id": [NSNull null], @"ok": @NO, @"error": @"Invalid JSON input" });
                    continue;
                }
                NSDictionary *req = (NSDictionary *)parsed;
                id reqId = req[@"id"] ?: [NSNull null];
                __block NSDictionary *res = nil;
                dispatch_sync(gStateQueue, ^{
                    res = handleCommand(req);
                });
                NSMutableDictionary *out = [res mutableCopy];
                out[@"id"] = reqId;
                writeJSONLine(out);
            }
        }
        free(lineBuf);

        // Clean up all virtual displays on stdin EOF
        dispatch_sync(gStateQueue, ^{
            [gManaged removeAllObjects];
        });
    }
    return 0;
}
