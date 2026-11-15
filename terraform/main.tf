terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state (S3 + lock) must be configured before the first apply.
  # backend "s3" {}
}

provider "aws" {
  region = var.region
}
