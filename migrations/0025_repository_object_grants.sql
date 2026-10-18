-- Blob references are accessible only through their enrolled repository binding.
CREATE TABLE repository_object_grants (
  binding TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY(binding, ref)
);
