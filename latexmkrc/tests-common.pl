# --- Clean up testsuite generated files ---
push @generated_exts, 'pdf.txt';

# Force warnings about undefined references/citations to be treated as errors
$warnings_as_errors = 1;
