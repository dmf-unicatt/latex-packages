# --- Clean up PythonTeX generated files and dirs ---
$clean_ext .= " pythontex-files-%R/* pythontex-files-%R";
$clean_ext .= " pythontex-files-%R/scripts/* pythontex-files-%R/scripts";
$clean_full_ext .= " notebooks-%R/* notebooks-%R";
push @generated_exts, 'pytxcode';

# --- Clean up markdown generated files and dirs ---
$clean_ext .= " _markdown_%R/* _markdown_%R";
push @generated_exts, 'debug-extensions.json';
push @generated_exts, 'markdown.in';

# --- PythonTeX command ---
$pythontex = 'pythontex %O %S';

# --- Check if source contains PythonTeX commands/environments ---
sub source_contains_pythontex {
    my ($file) = @_;

    open(my $fh, "<", $file);
    while (<$fh>) {
        # Direct PythonTeX usage
        if (/\\py\s*\{/
          || /\\begin\s*\{pycode\}/
          || /\\begin\s*\{pyblock\}/
          || /\\begin\s*\{pycell\}/
          || /\\begin\s*\{mdcell\}/
        ) {
            close $fh;
            return 1;
        }

        # Look for \input or \include
        if (/\\(?:input|include)\s*\{([^}]+)\}/) {
            my $included = $1;
            # Add .tex if no extension
            $included .= ".tex" unless $included =~ /\.[^}]+$/;
            # Recursively scan
            return 1 if source_contains_pythontex($included);
        }
    }
    close $fh;
    return 0;
}

# --- Detect main .tex file from CLI args ---
my $main_tex_file = "";
for my $arg (@ARGV) {
    if ($arg =~ /\.tex$/i) {
        $main_tex_file = $arg;
        # If multiple files are provided on CLI args only the first .tex file will be checked
        last;
    }
}

# --- Enable PythonTeX rule if main file uses PythonTeX.          ---
# --- Also fall back to enabling it if main file was not provided ---
if ( !$main_tex_file || source_contains_pythontex($main_tex_file) ) {
    # Rule: run pythontex, produce .pytxmcr file, depend on .pytxcode
    $extra_rule_spec{'pythontex'} = [ 'internal', '', 'mypythontex',
        "%Y%R.pytxcode", "%Ypythontex-files-%R/%R.pytxmcr", "%R", 1 ];
} else {
    # Create empty rule for pythontex, as it is not needed
    $extra_rule_spec{'pythontex'} = ['', '', '', '', '', '', 1];
}

# --- Custom PythonTeX runner ---
sub mypythontex {
    my $result_dir = $aux_dir1 . "pythontex-files-$$Pbase";
    my $pytxcode = "$$Pbase.pytxcode";
    my $pytxmcr = "$result_dir/$$Pbase.pytxmcr";

    # Run PythonTeX
    my $ret = Run_subst($pythontex, 2);
    return $ret if $ret != 0;

    # Track all generated files for latexmk
    rdb_add_generated(glob "$result_dir/*");

    # If the output file is missing, force LaTeX rerun
    unless (-e $pytxmcr) {
        warn "mypythontex: '$pytxmcr' missing after pythontex run; forcing LaTeX re-run.\n";
        # Touch input file to trigger rebuild
        utime undef, undef, $pytxcode;
        # Create empty output file and return success to allow next pass to fix things
        open(my $fh, '>', $pytxmcr) or warn "Could not create '$pytxmcr': $!";
        close $fh;
        return 0;
    }

    # Parse dependencies from output file
    open(my $fh, "<", $pytxmcr) or die "mypythontex: Could not open '$pytxmcr' despite earlier existence check\n";
    while (<$fh>) {
        if (/^%PythonTeX dependency:\s+'([^']+)';/) {
            print "Found pythontex dependency '$1'\n";
            rdb_ensure_file($rule, $aux_dir1 . $1);
        }
    }
    close $fh;

    return $ret;
}
