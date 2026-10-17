# Future standalone artifacts

`standalone-artifacts.tf.example` retains the original R2 resource as a reference,
not active Terraform configuration. The production root contains no R2 resource
and Wrangler has no R2 binding. Future R2 support requires a separately reviewed
resource, Worker binding, permissions and executor implementation. Do not copy
this template into production for the D1 proof experiment.
