# One image for both roles, the sidecar and the edge proxy: the official
# Envoy image, plus iptables for interception and a small Python process
# that keeps the config files in step with S3.

# nosec: the official image of Envoy, a CNCF project.
FROM envoyproxy/envoy:v1.36-latest

#   iptables, sudo   the sidecar's interception rules (the edge proxy skips them)
#   curl             health checks, and the task's zone from ECS metadata
#   python3-botocore refresh.py's S3 reads
#   python3-yaml     refresh.py's split of eds.yaml into a file per service
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        curl \
        iptables \
        sudo \
        python3 \
        python3-botocore \
        python3-yaml \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/envoy/eds && chown -R 101:101 /etc/envoy

# Envoy runs as UID 101, which is also how iptables tells its traffic from the
# app's. It needs root only for the iptables rules at startup, through sudo.
RUN echo 'envoy ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

COPY entrypoint.sh refresh.py /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 15000 9901
USER 101
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
