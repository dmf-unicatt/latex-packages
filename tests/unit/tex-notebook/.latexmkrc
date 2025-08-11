# Prepend the packages directory to TEXINPUTS
$ENV{'TEXINPUTS'} = "../../../packages//:" . ($ENV{'TEXINPUTS'} // "");

# Load latexmkrc files
do '../../../latexmkrc/tex-notebook.pl' or die "Can't load tex-notebook.pl: $!";
do '../../../latexmkrc/tests-common.pl' or die "Can't load tests-common.pl: $!";
