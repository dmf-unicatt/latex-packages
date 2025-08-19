# Prepend the packages directory to TEXINPUTS
$ENV{'TEXINPUTS'} = "../../../packages//:" . ($ENV{'TEXINPUTS'} // "");

# Load latexmkrc files
do '../../../latexmkrc/pybeamerlecturenotes.pl' or die "Can't load pybeamerlecturenotes.pl: $!";
do '../../../latexmkrc/tests-common.pl' or die "Can't load tests-common.pl: $!";
