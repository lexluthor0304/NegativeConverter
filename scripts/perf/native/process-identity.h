// Developer harness only. These private XNU declarations are deliberately
// outside the application and require an exact-size response from libproc.
#include <libproc.h>
#include <sys/proc_info.h>
#include <stdint.h>
#include <unistd.h>

struct nc_unique_info {
    uint8_t uuid[16];
    uint64_t unique, parent_unique;
    int32_t version, original_parent_version;
    uint64_t reserved[2];
};

static NSDictionary *nc_identity(pid_t pid)
{
    struct nc_unique_info unique = {0}, again = {0};
    struct proc_bsdinfo bsd = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (pid <= 1 || sizeof(unique) != 56
        || proc_pidinfo(pid, 17, 0, &unique, sizeof(unique)) != sizeof(unique)
        || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd)
        || proc_pidpath(pid, path, sizeof(path)) <= 0
        || proc_pidinfo(pid, 17, 0, &again, sizeof(again)) != sizeof(again)
        || unique.unique != again.unique || unique.version != again.version
        || !unique.unique || bsd.pbi_uid != geteuid()) return nil;
    return @{ @"pid": @(pid), @"unique": [NSString stringWithFormat:@"%llu", unique.unique],
        @"version": @(unique.version), @"parentUnique": [NSString stringWithFormat:@"%llu", unique.parent_unique],
        @"parentPid": @(bsd.pbi_ppid), @"uid": @(bsd.pbi_uid), @"path": @(path) };
}
