# Local build of the sandbox's seccomp program. The image builds the same thing in deploy/Dockerfile.
sandbox.bpf: gen
	./gen $@

gen: gen.c
	$(CC) -O2 -Wall -Werror -o $@ $< -lseccomp

clean:
	rm -f gen sandbox.bpf
