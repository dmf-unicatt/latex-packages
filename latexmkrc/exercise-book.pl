use File::Basename;
use Cwd 'abs_path';
my $latexmkrcdir = dirname(abs_path(__FILE__));

# --- XSIM notebook folder creation requires shell escape ---
do "$latexmkrcdir/force-shell-escape.pl" or die "Can't load force-shell-escape.pl: $!";

# --- exercise-book uses tex-notebook ---
do "$latexmkrcdir/tex-notebook.pl" or die "Can't load tex-notebook.pl: $!";

# --- Clean up XSIM generated files and dirs ---
$clean_ext .= " xsim-files-%R/* xsim-files-%R";
push @generated_exts, 'xsim';
push @generated_exts, 'xsimlabelmap';
push @generated_exts, 'xsimlast';

# --- Let XSIM finish before generating notebooks ---
sub mypythontex_with_xsim_check {
    # If XSIM file isn't present yet, wait
    my $xsimfile = $aux_dir1 . "$$Pbase.xsim";
    unless (-e $xsimfile) {
        die "mypythontex_with_xsim_check: latex did not produce a XSIM file.";
    }

    # pythontex input and output files
    my $result_dir = $aux_dir1 . "pythontex-files-$$Pbase";
    unless (-d $result_dir) {
        mkdir $result_dir
            or die "Could not create directory '$result_dir': $!";
    }
    my $pytxcode = "$$Pbase.pytxcode";
    my $pytxmcr = "$result_dir/$$Pbase.pytxmcr";

    # If XSIM file still has mismatches, wait
    if (has_printed_with_print_false($xsimfile)) {
        warn "mypythontex_with_xsim_check: XSIM file not yet stable; waiting.";
        # Touch input file to trigger rebuild
        utime undef, undef, $pytxcode;
        # Create empty output file and return success to allow next pass to fix things
        open(my $fh, '>', $pytxmcr) or warn "Could not create '$pytxmcr': $!";
        close $fh;
        return 0;
    }

    # Ready: call original implementation
    return mypythontex();
}

if (exists $extra_rule_spec{'pythontex'}) {
    $extra_rule_spec{'pythontex'}[2] = 'mypythontex_with_xsim_check';
}

#------------------------------------------------------------
# has_printed_with_print_false($xsim_path)
#
# PURPOSE:
#   Determine whether the given .xsim file contains any exercises
#   that have:
#       printed = true   (i.e., the exercise was printed in this run)
#   AND
#       print = false    (i.e., the exercise is flagged to NOT print
#                        on the next run)
#
#   This situation happens in XSIM when an exercise is printed during
#   the current LaTeX run, but a later code path (e.g., \SetExerciseProperty)
#   turns off its "print" flag. On the next run, LaTeX will then *not*
#   print it again, so if we trigger other tools (like PythonTeX) before
#   this "state mismatch" is resolved, we may end up running them with
#   stale or incomplete exercise data.
#
# PARAMETERS:
#   $xsim_path  - Path to the .xsim file produced by XSIM.
#
# RETURNS:
#   1  => mismatch exists (at least one exercise printed=true and print=false)
#   0  => no mismatch (safe to proceed)
#
# USAGE:
#   if ( has_printed_with_print_false("main.xsim") ) {
#       warn "XSIM state not stable yet; delaying dependent rule.\n";
#   }
#
# FILE FORMAT DETAILS:
#   The .xsim file contains macros like:
#       \XSIM{print}{exercise-5=={false}||exercise-6=={true}}
#       \XSIM{printed}{exercise-5=={true}||exercise-6=={true}}
#
#   - The {print} list shows whether each exercise should be printed
#     in the NEXT run.
#   - The {printed} list shows whether each exercise WAS printed in
#     the CURRENT run.
#
#   We parse both into hashes (%print, %printed) keyed by exercise ID.
#------------------------------------------------------------
sub has_printed_with_print_false {
    my ($xsim_path) = @_;

    # Try to open the .xsim file, die with an error if missing or unreadable.
    open my $fh, '<', $xsim_path
        or die "Could not open $xsim_path: $!";

    my %print;    # Stores desired print status for next run
    my %printed;  # Stores actual printed status for current run

    # Read file line-by-line
    while (<$fh>) {
        # Capture the 'print' macro block
        if (/\\XSIM\{print\}\{(.+)\}/) {
            _parse_xsim_assignments($1, \%print);
        }
        # Capture the 'printed' macro block
        elsif (/\\XSIM\{printed\}\{(.+)\}/) {
            _parse_xsim_assignments($1, \%printed);
        }
    }
    close $fh;

    # Compare: find any exercise that WAS printed but will NOT be printed next run
    for my $ex (keys %printed) {
        if ($printed{$ex} eq 'true' && exists $print{$ex} && $print{$ex} eq 'false') {
            return 1; # Found mismatch, no need to check further
        }
    }

    return 0; # No mismatch found
}

#------------------------------------------------------------
# _parse_xsim_assignments($assignments, $hashref)
#
# PURPOSE:
#   Parse an XSIM assignment list like:
#       exercise-5=={false}||exercise-6=={true}
#   into a hash mapping exercise IDs to string values ("true" or "false").
#
# PARAMETERS:
#   $assignments - String containing assignment list.
#   $hashref     - Reference to hash to populate.
#
# RETURNS:
#   Nothing (modifies hash in-place).
#
# NOTE:
#   The list entries are separated by '||'.
#   Each entry matches:
#       (exercise-N)=={true|false}
#------------------------------------------------------------
sub _parse_xsim_assignments {
    my ($assignments, $hashref) = @_;
    for my $pair (split /\|\|/, $assignments) {
        if ($pair =~ /(exercise-\d+)==\{(true|false)\}/) {
            $hashref->{$1} = $2;
        }
    }
}
