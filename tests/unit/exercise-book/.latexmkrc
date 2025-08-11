# Prepend the packages directory to TEXINPUTS
$ENV{'TEXINPUTS'} = "../../../packages//:" . ($ENV{'TEXINPUTS'} // "");

# Load latexmkrc files
do '../../../latexmkrc/force-shell-escape.pl' or die "Can't load force-shell-escape.pl: $!";
my $file = '../../../latexmkrc/tex-notebook.pl';

eval {
    do $file or die "Failed to do $file: $!";
    1;
} or do {
    warn "Error loading $file a: $@";
    die $@;
};

do '../../../latexmkrc/xsim.pl' or die "Can't load xsim.pl: $!";
do '../../../latexmkrc/tests-common.pl' or die "Can't load tests-common.pl: $!";
