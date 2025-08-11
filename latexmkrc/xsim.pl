# --- Clean up XSIM generated files and dirs ---
$clean_ext .= " xsim-files-%R/* xsim-files-%R";
push @generated_exts, 'xsim';
