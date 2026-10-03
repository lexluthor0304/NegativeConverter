// Injected only into a harness-owned developer process, never shipped.
// Observe both the view's native PIDs and their one-shot XPC endpoints.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <xpc/xpc.h>
#include <uuid/uuid.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <sys/stat.h>
#include "process-identity.h"

extern void xpc_connection_set_oneshot_instance(xpc_connection_t, uuid_t);
static pthread_mutex_t endpoint_lock = PTHREAD_MUTEX_INITIALIZER;
static struct { void *connection; uuid_t instance; pid_t pid; audit_token_t token; } endpoints[128];
static NSHashTable *views;
static NSDictionary *last_snapshot;
static IMP original_init;
static int report_fd = -1, harness_port;
static dispatch_source_t timer;

static void nc_set_instance(xpc_connection_t connection, uuid_t instance)
{
    xpc_connection_set_oneshot_instance(connection, instance);
    pthread_mutex_lock(&endpoint_lock);
    for (int i = 0; i < 128; i++) if (!endpoints[i].connection || endpoints[i].connection == (__bridge void *)connection) {
        endpoints[i].connection = (__bridge void *)connection;
        uuid_copy(endpoints[i].instance, instance);
        endpoints[i].pid = 0;
        break;
    }
    pthread_mutex_unlock(&endpoint_lock);
}

static pid_t nc_get_pid(xpc_connection_t connection)
{
    pid_t pid = xpc_connection_get_pid(connection);
    void (*get_token)(xpc_connection_t, audit_token_t *) = dlsym(RTLD_DEFAULT, "xpc_connection_get_audit_token");
    audit_token_t token = {0};
    if (get_token && pid > 1) get_token(connection, &token);
    pthread_mutex_lock(&endpoint_lock);
    for (int i = 0; i < 128; i++) if (endpoints[i].connection == (__bridge void *)connection && pid > 1) {
        endpoints[i].pid = pid;
        endpoints[i].token = token;
        break;
    }
    pthread_mutex_unlock(&endpoint_lock);
    return pid;
}

__attribute__((used)) static struct { const void *replacement, *original; } interposes[]
    __attribute__((section("__DATA,__interpose"))) = {
        { (const void *)nc_set_instance, (const void *)xpc_connection_set_oneshot_instance },
        { (const void *)nc_get_pid, (const void *)xpc_connection_get_pid }
    };

static NSDictionary *nc_endpoint(pid_t pid)
{
    NSDictionary *identity = nc_identity(pid);
    if (!identity) return nil;
    NSDictionary *result = nil;
    pthread_mutex_lock(&endpoint_lock);
    for (int i = 0; i < 128; i++) if (endpoints[i].pid == pid
        && endpoints[i].token.val[5] == pid
        && endpoints[i].token.val[7] == [identity[@"version"] unsignedIntValue]) {
        uuid_string_t instance;
        uuid_unparse_lower(endpoints[i].instance, instance);
        NSMutableArray *token = [NSMutableArray array];
        for (int j = 0; j < 8; j++) [token addObject:@(endpoints[i].token.val[j])];
        result = @{ @"identity": identity, @"instance": @(instance), @"auditToken": token };
        break;
    }
    pthread_mutex_unlock(&endpoint_lock);
    return result;
}

static void nc_report(void)
{
    @autoreleasepool {
        NSDictionary *owner = nc_identity(getpid());
        if (!owner) return;
        NSMutableArray *ancestors = [NSMutableArray array];
        NSDictionary *parent = owner;
        for (int i = 0; i < 32; i++) {
            parent = nc_identity([parent[@"parentPid"] intValue]);
            if (!parent) break;
            [ancestors addObject:parent];
        }
        NSMutableArray *associations = [NSMutableArray array];
        SEL renderer_selector = NSSelectorFromString(@"_webProcessIdentifier");
        SEL gpu_selector = NSSelectorFromString(@"_gpuProcessIdentifier");
        for (WKWebView *view in views.allObjects) {
            NSURL *url = view.URL;
            if (![url.scheme isEqualToString:@"http"] || ![url.host isEqualToString:@"127.0.0.1"]
                || url.port.intValue != harness_port || ![view respondsToSelector:renderer_selector]
                || ![view respondsToSelector:gpu_selector]) continue;
            pid_t renderer = ((pid_t (*)(id, SEL))objc_msgSend)(view, renderer_selector);
            pid_t gpu = ((pid_t (*)(id, SEL))objc_msgSend)(view, gpu_selector);
            NSDictionary *r = nc_endpoint(renderer), *g = nc_endpoint(gpu);
            if (r && g) [associations addObject:@{ @"renderer": r, @"gpu": g }];
        }
        NSDictionary *snapshot = @{ @"source": @"wkwebview+xpc-oneshot", @"owner": owner,
            @"ancestors": ancestors, @"port": @(harness_port), @"views": associations };
        if ([snapshot isEqualToDictionary:last_snapshot]) return;
        last_snapshot = snapshot;
        NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil];
        if (!data || data.length > 32768) return;
        NSMutableData *line = [data mutableCopy];
        [line appendBytes:"\n" length:1];
        write(report_fd, line.bytes, line.length);
    }
}

static id nc_init(id self, SEL selector, NSRect frame, WKWebViewConfiguration *configuration)
{
    id view = ((id (*)(id, SEL, NSRect, id))original_init)(self, selector, frame, configuration);
    if (view) [views addObject:view];
    return view;
}

__attribute__((constructor)) static void nc_install(void)
{
    @autoreleasepool {
        const char *file = getenv("NC_PERF_OWNERSHIP_LOG");
        harness_port = atoi(getenv("NC_PERF_OWNERSHIP_PORT") ?: "0");
        if (!file || harness_port < 1 || harness_port > 65535) return;
        report_fd = open(file, O_WRONLY | O_APPEND | O_NOFOLLOW);
        struct stat st;
        if (report_fd < 0 || fstat(report_fd, &st) || !S_ISREG(st.st_mode)
            || st.st_uid != geteuid() || (st.st_mode & 077) != 0) {
            if (report_fd >= 0) close(report_fd);
            report_fd = -1;
            return;
        }
        views = [NSHashTable weakObjectsHashTable];
        Method method = class_getInstanceMethod(WKWebView.class, @selector(initWithFrame:configuration:));
        if (!method) return;
        original_init = method_setImplementation(method, (IMP)nc_init);
        timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 250 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(timer, ^{ nc_report(); });
        dispatch_resume(timer);
    }
}
