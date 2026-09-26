# Built from the repository root, like every service: docker build -f infra/elasticsearch/Dockerfile .
FROM docker.elastic.co/elasticsearch/elasticsearch:9.5.4
# Starts as root only to hand Railway's root-owned volume to uid 1000; the entrypoint then drops to it.
USER root
COPY infra/elasticsearch/elasticsearch.yml /usr/share/elasticsearch/config/elasticsearch.yml
COPY infra/elasticsearch/railway-entrypoint.sh /usr/local/bin/railway-entrypoint.sh
ENTRYPOINT ["/bin/tini", "--", "/bin/sh", "/usr/local/bin/railway-entrypoint.sh"]
# Setting ENTRYPOINT clears the CMD inherited from the base image.
CMD ["eswrapper"]
