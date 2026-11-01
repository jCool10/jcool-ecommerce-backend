# Every image this repo publishes. Always pass `-f docker-bake.hcl`: without it bake also merges
# docker-compose.yml and turns each compose service into a target.
#   docker buildx bake -f docker-bake.hcl --print all

variable "CACHE_REPO" { default = "ghcr.io/jcool10/jcool-build-cache" }
variable "CACHE_ARCH" { default = "arm64" }
variable "TAG" { default = "ci" }

target "_common" {
  context = "."
}

target "api" {
  inherits   = ["_common"]
  dockerfile = "Dockerfile"
  tags       = ["jcool-api:${TAG}"]
  cache-from = ["type=registry,ref=${CACHE_REPO}:api-${CACHE_ARCH}"]
}

target "app" {
  name = app
  matrix = {
    app = ["gateway", "id-service", "user-service", "inventory-service", "payment-service", "order-service"]
  }
  inherits   = ["_common"]
  dockerfile = "apps/${app}/Dockerfile"
  tags       = ["jcool-${app}:${TAG}"]
  cache-from = ["type=registry,ref=${CACHE_REPO}:${app}-${CACHE_ARCH}"]
}

target "infra" {
  name = infra
  matrix = {
    infra = ["temporal", "elasticsearch", "prometheus", "loki", "grafana"]
  }
  inherits   = ["_common"]
  dockerfile = "infra/${infra}/Dockerfile"
  tags       = ["jcool-${infra}:${TAG}"]
  cache-from = ["type=registry,ref=${CACHE_REPO}:${infra}-${CACHE_ARCH}"]
}

group "stack" {
  targets = ["api", "gateway", "id-service", "user-service", "inventory-service", "payment-service", "order-service", "temporal"]
}

group "all" {
  targets = ["api", "gateway", "id-service", "user-service", "inventory-service", "payment-service", "order-service", "temporal", "elasticsearch", "prometheus", "loki", "grafana"]
}
