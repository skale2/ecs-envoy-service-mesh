# =============================================================================
# Envoy Sidecar / Edge Proxy Container
#
# Built on the official envoyproxy/envoy image, which provides a
# production-ready Envoy binary. We extend it with iptables (for
# transparent egress interception in sidecar mode) and the AWS CLI
# (for pulling xDS configs from S3).
# =============================================================================

# Official Envoy image -- provides the envoy binary, default configs,
# and the envoy user (UID 101) already baked in.
FROM envoyproxy/envoy:v1.29-latest

# Install dependencies:
#   - iptables: used by the entrypoint (in sidecar mode) to set up NAT rules
#     that redirect outgoing TCP traffic to Envoy's listener port. Not needed
#     by the edge proxy, but included so a single image serves both roles.
#   - curl: used by ECS health checks (curl localhost:9901/ready).
#   - AWS CLI: used to pull xDS config files from S3 at startup and in the
#     background refresh loop.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        bash \
        unzip \
        iptables \
        sudo \
    && curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws \
    && apt-get remove -y unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/envoy && chown -R 101:101 /etc/envoy

# Give the envoy user (UID 101) passwordless sudo so it can run iptables
# as root while the container itself runs as non-root. This mirrors the
# pattern used in production: the process runs as a non-root user for
# safety, but elevates briefly to set up NAT rules at startup.
RUN echo 'envoy ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 15000 9901

# Run as the envoy user (UID 101). The iptables rules use --uid-owner 101
# to skip Envoy's own traffic and prevent infinite redirect loops.
# iptables commands in the entrypoint use `sudo` to elevate briefly.
USER 101

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
