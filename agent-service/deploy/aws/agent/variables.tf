variable "stack" {
  description = "Which environment this is: develop or production. develop is the default workspace; production gets its own."
  type        = string
  default     = "develop"
  validation {
    condition     = contains(["develop", "production"], var.stack)
    error_message = "stack is develop or production."
  }
}

variable "region" {
  description = "The region of the E2B stack this one sits beside. Peering is same-region only."
  type        = string
  default     = "eu-central-1"
}

variable "e2b_name" {
  description = "Name tag of the E2B stack to sit beside (its VPC, security group and address carry it), as ../e2b named it. Changing it moves the peering, nothing else."
  type        = string
}

variable "vpc_cidr" {
  description = "This stack's VPC. It must not overlap the E2B VPC (10.10.0.0/16) or the sandbox networks on the E2B host (10.11.0.0/16, 10.12.0.0/16)."
  type        = string
  default     = "10.20.0.0/16"
  validation {
    condition = (can(cidrnetmask(var.vpc_cidr)) &&
    !contains(["10.10", "10.11", "10.12"], join(".", slice(split(".", cidrhost(var.vpc_cidr, 0)), 0, 2))))
    error_message = "vpc_cidr must be an IPv4 network that is not 10.10, 10.11 or 10.12 (the E2B VPC and its sandbox networks)."
  }
}

variable "agent_hostname" {
  description = "The public name the web app calls (AGENT_SERVICE_URL's host). Its DNS record is a CNAME to the load balancer (output alb_dns_name)."
  type        = string
}

variable "gateway_hostname" {
  description = "The gateway's public name, which E2B sandboxes call for model nonces (AGENT_GATEWAY_PUBLIC_URL's host). A CNAME to the same load balancer."
  type        = string
}

variable "agent_instance_type" {
  description = "The agent's EC2 type. c7i.xlarge (4 vCPU, 8 GiB) matches the Fly machine it replaces. Keep a type with EncryptionInTransitSupported, so traffic to the E2B host and the gateway is encrypted by the Nitro card."
  type        = string
  default     = "c7i.xlarge"
}

variable "gateway_instance_type" {
  description = "The gateway's EC2 type. c7i.large (2 vCPU, 4 GiB) is the smallest type with in-transit encryption that builds the image comfortably."
  type        = string
  default     = "c7i.large"
}

variable "agent_data_gb" {
  description = "The agent's /data volume (tasks.db and per-session scratch). Fly's is 1 GB; this leaves room for scratch."
  type        = number
  default     = 20
}

variable "ami" {
  description = "Host image. Empty reads Amazon Linux 2023's current image at plan time; a running instance ignores later changes (replace it on purpose)."
  type        = string
  default     = ""
}
