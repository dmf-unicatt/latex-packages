# Prepend the packages directory to TEXINPUTS
$ENV{'TEXINPUTS'} = "../../../../packages//:" . ($ENV{'TEXINPUTS'} // "");

# Load latexmkrc files
do '../../../../latexmkrc/pybeamerlectureslides.pl' or die "Can't load pybeamerlectureslides.pl: $!";
do '../../../../latexmkrc/tests-common.pl' or die "Can't load tests-common.pl: $!";
