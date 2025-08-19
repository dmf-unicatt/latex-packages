use File::Basename;
use Cwd 'abs_path';
my $latexmkrcdir = dirname(abs_path(__FILE__));

# --- pybeamernotebook uses tex-notebook ---
do "$latexmkrcdir/tex-notebook.pl" or die "Can't load tex-notebook.pl: $!";

# --- pybeamernotebook uses beamerthemeunicatt ---
do "$latexmkrcdir/beamerthemeunicatt.pl" or die "Can't load beamerthemeunicatt.pl: $!";

# --- Do not build tex files in chapters/ and slides/ ---
push @ignore_files, glob("chapters/*.tex");
push @ignore_files, glob("slides/*.tex");

# --- On clean up clean auxiliary files in chapters/ and slides/ ---
if (exists $::hooks{'cleanup'}) {
    add_hook('cleanup', sub {
        my @aux_exts = (@generated_exts, @$clean_ext, 'fdb_latexmk');
        my @folders = ('chapters', 'slides');

        foreach my $dir (@folders) {
            print "latexmk: cleaning aux files in $dir/, extensions @aux_exts\n";

            foreach my $ext (@aux_exts) {
                foreach my $file (glob("$dir/*.$ext")) {
                    if (unlink $file) {
                        print "  removed $file\n";
                    } else {
                        warn "  could not remove $file: $!\n" if -e $file;
                    }
                }
            }
        }

        return 0;
    });
} else {
    print "latexmk: cleanup hook is not available\n";
}
if (exists $::hooks{'cleanup_extra_full'}) {
    add_hook('cleanup_extra_full', sub {
        my @full_aux_exts = ('pdf', 'dvi', 'ps', 'synctex.gz', @$clean_full_ext);
        my @folders = ('chapters', 'slides');

        foreach my $dir (@folders) {
            print "latexmk: cleaning built files in $dir/, extensions @full_aux_exts\n";

            foreach my $ext (@full_aux_exts) {
                foreach my $file (glob("$dir/*.$ext")) {
                    if (unlink $file) {
                        print "  removed $file\n";
                    } else {
                        warn "  could not remove $file: $!\n" if -e $file;
                    }
                }
            }
        }

        return 0;
    });
} else {
    print "latexmk: cleanup_extra_full hook is not available\n";
}
