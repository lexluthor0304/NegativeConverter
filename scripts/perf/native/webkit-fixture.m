// Tiny owned correctness fixture, no application bundle, images or user tabs.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>

int main(int argc, const char *argv[])
{
    @autoreleasepool {
        if (argc != 2) return 2;
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 160, 120)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 160, 120) configuration:configuration];
        window.contentView = view;
        [window orderFront:nil];
        [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@(argv[1])]]];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ [app terminate:nil]; });
        __block pid_t last_renderer = 0, last_gpu = 0;
        [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
            SEL r = NSSelectorFromString(@"_webProcessIdentifier"), g = NSSelectorFromString(@"_gpuProcessIdentifier");
            if (![view respondsToSelector:r] || ![view respondsToSelector:g]) return;
            pid_t renderer = ((pid_t (*)(id, SEL))objc_msgSend)(view, r);
            pid_t gpu = ((pid_t (*)(id, SEL))objc_msgSend)(view, g);
            if (renderer && gpu && (renderer != last_renderer || gpu != last_gpu)) {
                printf("{\"owner\":%d,\"renderer\":%d,\"gpu\":%d}\n", getpid(), renderer, gpu);
                fflush(stdout);
                last_renderer = renderer; last_gpu = gpu;
            }
        }];
        [app run];
    }
    return 0;
}
