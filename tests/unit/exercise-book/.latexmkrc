# Prepend the packages directory to TEXINPUTS
$ENV{'TEXINPUTS'} = "../../../packages//:" . ($ENV{'TEXINPUTS'} // "");

# Load latexmkrc files
do '../../../latexmkrc/exercise-book.pl' or die "Can't load exercise-book.pl: $!";
do '../../../latexmkrc/tests-common.pl' or die "Can't load tests-common.pl: $!";
