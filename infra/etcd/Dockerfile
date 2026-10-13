# Built from the repository root, like every service: docker build -f infra/etcd/Dockerfile .
# The id-service's node leases. A single member: the replicas mint through an outage until their
# fence, and the keyspace is small enough to rebuild by the RUNBOOK if the volume is lost.
FROM gcr.io/etcd-development/etcd:v3.6.5
# The volume mounts at /var/lib/etcd and etcd creates its data dir inside it, owner-only as it wants.
# ETCD_ADVERTISE_CLIENT_URLS comes from the platform, which knows the host name.
ENV ETCD_NAME=id-etcd \
    ETCD_DATA_DIR=/var/lib/etcd/data \
    ETCD_LISTEN_CLIENT_URLS=http://[::]:2379 \
    ETCD_AUTO_COMPACTION_MODE=periodic \
    ETCD_AUTO_COMPACTION_RETENTION=1h
EXPOSE 2379
CMD ["/usr/local/bin/etcd"]
