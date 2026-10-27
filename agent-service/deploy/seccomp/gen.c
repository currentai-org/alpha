// Writes the sandbox's seccomp program (raw BPF, what `bwrap --seccomp FD` reads) to argv[1] (CUR-4478).
//
// Default allow, with EPERM for the syscalls unprivileged kernel exploits start from and that nothing a
// person's code or the agent needs: io_uring, bpf, perf_event_open, userfaultfd, the key store, every
// mount call, namespace entry, ptrace and cross-process memory, module and kexec loading. The list follows
// Flatpak's bwrap filter (flatpak-run.c, setup_seccomp). Foreign-architecture syscalls (i386, x32) kill
// the process, libseccomp's default for a filter that names only the native arch, so the 32-bit entry
// points cannot be used to step around the list.
//
// Built in the image (deploy/Dockerfile) against libseccomp; `make -C deploy/seccomp` builds it locally.
#include <errno.h>
#include <seccomp.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>

static const char *denied[] = {
    "io_uring_setup", "io_uring_enter", "io_uring_register",
    "bpf", "perf_event_open", "userfaultfd",
    "keyctl", "add_key", "request_key",
    "mount", "umount2", "pivot_root", "move_mount", "open_tree", "fsopen", "fsconfig", "fsmount",
    "fspick", "mount_setattr",
    "unshare", "setns",
    "ptrace", "process_vm_readv", "process_vm_writev",
    "init_module", "finit_module", "delete_module", "kexec_load", "kexec_file_load",
    "reboot", "swapon", "swapoff", "acct", "quotactl", "quotactl_fd",
};

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s OUT.bpf\n", argv[0]);
        return 2;
    }
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) return 1;
    int rc = 0;
    for (size_t i = 0; i < sizeof denied / sizeof *denied && rc == 0; i++) {
        int nr = seccomp_syscall_resolve_name(denied[i]);
        if (nr == __NR_SCMP_ERROR) {
            fprintf(stderr, "unknown syscall %s\n", denied[i]);
            rc = -1;
            break;
        }
        rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0);
    }
    // Typing into the controlling terminal, a sandbox escape when a tty is shared (Flatpak blocks both).
    if (rc == 0) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ioctl), 1,
                                       SCMP_A1(SCMP_CMP_MASKED_EQ, 0xFFFFFFFFu, TIOCSTI));
    if (rc == 0) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ioctl), 1,
                                       SCMP_A1(SCMP_CMP_MASKED_EQ, 0xFFFFFFFFu, TIOCLINUX));
    // vsock is not scoped by a network namespace, so `--unshare-net` does not cut it: on a Firecracker
    // machine it reaches the host side.
    if (rc == 0) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
                                       SCMP_A0(SCMP_CMP_EQ, AF_VSOCK));
    if (rc != 0) {
        fprintf(stderr, "seccomp rule failed: %d\n", rc);
        seccomp_release(ctx);
        return 1;
    }
    int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        perror(argv[1]);
        seccomp_release(ctx);
        return 1;
    }
    rc = seccomp_export_bpf(ctx, fd);
    close(fd);
    seccomp_release(ctx);
    if (rc != 0) {
        fprintf(stderr, "export failed: %d\n", rc);
        return 1;
    }
    return 0;
}
